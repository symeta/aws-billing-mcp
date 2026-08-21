#!/usr/bin/env node
/**
 * aws-billing-mcp — MCP server for AWS Billing and Cost Management.
 *
 * Exposes Cost Explorer, Budgets, Cost Anomaly Detection and commitment
 * (Savings Plans / RI) utilization data by shelling out to the AWS CLI.
 * Intended for account 135709585800; the account is verified on first use.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const EXPECTED_ACCOUNT = process.env.EXPECTED_ACCOUNT || "135709585800";
const AWS_BIN = process.env.AWS_CLI_BIN || "aws";
// Keep tool responses within a size an MCP client can comfortably handle.
const MAX_OUTPUT_CHARS = 60_000;

async function runAws(args) {
  try {
    const { stdout } = await execFileAsync(
      AWS_BIN,
      [...args, "--output", "json", "--no-cli-pager"],
      { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }
    );
    return stdout.trim() ? JSON.parse(stdout) : {};
  } catch (err) {
    const detail = (err.stderr || err.message || "").trim();
    throw new Error(`aws ${args[0]} ${args[1] ?? ""} failed: ${detail}`);
  }
}

let accountChecked = false;
async function ensureAccount() {
  if (accountChecked) return;
  const identity = await runAws(["sts", "get-caller-identity"]);
  if (identity.Account !== EXPECTED_ACCOUNT) {
    throw new Error(
      `Current AWS credentials belong to account ${identity.Account}, ` +
        `but this server is configured for account ${EXPECTED_ACCOUNT}. ` +
        `Check AWS_PROFILE / credentials.`
    );
  }
  accountChecked = true;
}

function asResult(data) {
  let text = JSON.stringify(data, null, 2);
  if (text.length > MAX_OUTPUT_CHARS) {
    text =
      text.slice(0, MAX_OUTPUT_CHARS) +
      `\n... [truncated: response exceeded ${MAX_OUTPUT_CHARS} characters. ` +
      `Narrow the time period, use MONTHLY granularity, or add a filter.]`;
  }
  return { content: [{ type: "text", text }] };
}

function asError(err) {
  return {
    content: [{ type: "text", text: String(err.message || err) }],
    isError: true,
  };
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const dateSchema = z
  .string()
  .regex(datePattern, "Must be YYYY-MM-DD")
  .describe("Date in YYYY-MM-DD format");

const server = new McpServer({
  name: "aws-billing",
  version: "1.0.0",
});

/* ------------------------------------------------------------------ */
/* get_cost_and_usage                                                  */
/* ------------------------------------------------------------------ */
server.tool(
  "get_cost_and_usage",
  "Query AWS cost and usage for account " +
    EXPECTED_ACCOUNT +
    " over a time period. Supports grouping (e.g. by SERVICE, USAGE_TYPE, REGION, " +
    "LINKED_ACCOUNT, or a cost allocation TAG) and Cost Explorer filter expressions. " +
    "Start date is inclusive, end date is exclusive. This is the primary tool for " +
    "spend analysis: monthly trends, per-service breakdowns, daily spikes, etc.",
  {
    start: dateSchema.describe("Start date (inclusive), YYYY-MM-DD"),
    end: dateSchema.describe("End date (exclusive), YYYY-MM-DD"),
    granularity: z
      .enum(["DAILY", "MONTHLY", "HOURLY"])
      .default("MONTHLY")
      .describe("Time granularity. Prefer MONTHLY for trends, DAILY for spike analysis."),
    metrics: z
      .array(
        z.enum([
          "UnblendedCost",
          "BlendedCost",
          "AmortizedCost",
          "NetUnblendedCost",
          "NetAmortizedCost",
          "UsageQuantity",
          "NormalizedUsageAmount",
        ])
      )
      .default(["UnblendedCost"])
      .describe("Cost metrics to return. UsageQuantity is only meaningful when grouped/filtered to one usage type."),
    group_by: z
      .array(
        z.object({
          type: z.enum(["DIMENSION", "TAG", "COST_CATEGORY"]),
          key: z
            .string()
            .describe(
              "For DIMENSION: SERVICE, USAGE_TYPE, REGION, LINKED_ACCOUNT, INSTANCE_TYPE, " +
                "PURCHASE_TYPE, RECORD_TYPE, OPERATION, etc. For TAG/COST_CATEGORY: the key name."
            ),
        })
      )
      .max(2)
      .optional()
      .describe("Group results by up to 2 dimensions/tags."),
    filter: z
      .record(z.any())
      .optional()
      .describe(
        'Optional Cost Explorer filter Expression as JSON, e.g. ' +
          '{"Dimensions":{"Key":"SERVICE","Values":["Amazon Elastic Compute Cloud - Compute"]}}. ' +
          "Supports And/Or/Not, Dimensions, Tags, CostCategories."
      ),
  },
  async ({ start, end, granularity, metrics, group_by, filter }) => {
    try {
      await ensureAccount();
      const baseArgs = [
        "ce",
        "get-cost-and-usage",
        "--time-period",
        `Start=${start},End=${end}`,
        "--granularity",
        granularity,
        "--metrics",
        ...metrics,
      ];
      if (group_by?.length) {
        baseArgs.push(
          "--group-by",
          JSON.stringify(group_by.map((g) => ({ Type: g.type, Key: g.key })))
        );
      }
      if (filter) baseArgs.push("--filter", JSON.stringify(filter));

      // Follow pagination (a few pages at most) so grouped results are complete.
      const results = [];
      let attributes = [];
      let token;
      for (let page = 0; page < 5; page++) {
        const args = token
          ? [...baseArgs, "--next-page-token", token]
          : baseArgs;
        const res = await runAws(args);
        results.push(...(res.ResultsByTime || []));
        attributes = res.DimensionValueAttributes || attributes;
        token = res.NextPageToken;
        if (!token) break;
      }
      return asResult({
        Account: EXPECTED_ACCOUNT,
        ResultsByTime: results,
        DimensionValueAttributes: attributes,
        ...(token ? { Note: "More pages exist; narrow the query." } : {}),
      });
    } catch (err) {
      return asError(err);
    }
  }
);

/* ------------------------------------------------------------------ */
/* get_dimension_values                                                */
/* ------------------------------------------------------------------ */
server.tool(
  "get_dimension_values",
  "List available values for a Cost Explorer dimension in a time period — e.g. which " +
    "services, regions, usage types, or linked accounts actually incurred cost. Use this " +
    "to discover exact value strings before filtering in get_cost_and_usage.",
  {
    dimension: z
      .enum([
        "SERVICE",
        "USAGE_TYPE",
        "REGION",
        "LINKED_ACCOUNT",
        "INSTANCE_TYPE",
        "OPERATION",
        "PURCHASE_TYPE",
        "RECORD_TYPE",
        "USAGE_TYPE_GROUP",
        "PLATFORM",
        "DATABASE_ENGINE",
        "BILLING_ENTITY",
      ])
      .describe("Dimension to enumerate"),
    start: dateSchema,
    end: dateSchema,
    search_string: z
      .string()
      .optional()
      .describe("Optional substring to filter values (e.g. 'Bedrock')"),
  },
  async ({ dimension, start, end, search_string }) => {
    try {
      await ensureAccount();
      const args = [
        "ce",
        "get-dimension-values",
        "--dimension",
        dimension,
        "--time-period",
        `Start=${start},End=${end}`,
      ];
      if (search_string) args.push("--search-string", search_string);
      return asResult(await runAws(args));
    } catch (err) {
      return asError(err);
    }
  }
);

/* ------------------------------------------------------------------ */
/* get_cost_forecast                                                   */
/* ------------------------------------------------------------------ */
server.tool(
  "get_cost_forecast",
  "Forecast future AWS spend for the account over a date range (must start today or later). " +
    "Returns the mean forecast plus an 80% prediction interval.",
  {
    start: dateSchema.describe("Forecast start (inclusive, today or later), YYYY-MM-DD"),
    end: dateSchema.describe("Forecast end (exclusive), YYYY-MM-DD"),
    granularity: z.enum(["DAILY", "MONTHLY"]).default("MONTHLY"),
    metric: z
      .enum(["UNBLENDED_COST", "BLENDED_COST", "AMORTIZED_COST", "NET_UNBLENDED_COST", "NET_AMORTIZED_COST"])
      .default("UNBLENDED_COST"),
    filter: z
      .record(z.any())
      .optional()
      .describe("Optional Cost Explorer filter Expression (same format as get_cost_and_usage)"),
  },
  async ({ start, end, granularity, metric, filter }) => {
    try {
      await ensureAccount();
      const args = [
        "ce",
        "get-cost-forecast",
        "--time-period",
        `Start=${start},End=${end}`,
        "--granularity",
        granularity,
        "--metric",
        metric,
        "--prediction-interval-level",
        "80",
      ];
      if (filter) args.push("--filter", JSON.stringify(filter));
      return asResult(await runAws(args));
    } catch (err) {
      return asError(err);
    }
  }
);

/* ------------------------------------------------------------------ */
/* get_cost_anomalies                                                  */
/* ------------------------------------------------------------------ */
server.tool(
  "get_cost_anomalies",
  "List cost anomalies detected by AWS Cost Anomaly Detection in a date range, including " +
    "root causes and impact. Returns an empty list if no anomaly monitors are configured.",
  {
    start: dateSchema.describe("Anomaly search start date, YYYY-MM-DD"),
    end: dateSchema.describe("Anomaly search end date, YYYY-MM-DD"),
    max_results: z.number().int().min(1).max(100).default(50),
  },
  async ({ start, end, max_results }) => {
    try {
      await ensureAccount();
      return asResult(
        await runAws([
          "ce",
          "get-anomalies",
          "--date-interval",
          `StartDate=${start},EndDate=${end}`,
          "--max-results",
          String(max_results),
        ])
      );
    } catch (err) {
      return asError(err);
    }
  }
);

/* ------------------------------------------------------------------ */
/* describe_budgets                                                    */
/* ------------------------------------------------------------------ */
server.tool(
  "describe_budgets",
  "List AWS Budgets configured for the account, with limits, actual spend and forecast " +
    "against each budget.",
  {},
  async () => {
    try {
      await ensureAccount();
      return asResult(
        await runAws([
          "budgets",
          "describe-budgets",
          "--account-id",
          EXPECTED_ACCOUNT,
          "--max-results",
          "100",
        ])
      );
    } catch (err) {
      return asError(err);
    }
  }
);

/* ------------------------------------------------------------------ */
/* get_cost_allocation_tags                                            */
/* ------------------------------------------------------------------ */
server.tool(
  "get_cost_allocation_tags",
  "List cost allocation tag values seen in billing data for a time period. Provide tag_key " +
    "to list its values; omit it to list available tag keys. Use these keys with " +
    "group_by type=TAG in get_cost_and_usage.",
  {
    start: dateSchema,
    end: dateSchema,
    tag_key: z.string().optional().describe("Tag key to enumerate values for; omit to list tag keys"),
  },
  async ({ start, end, tag_key }) => {
    try {
      await ensureAccount();
      const args = ["ce", "get-tags", "--time-period", `Start=${start},End=${end}`];
      if (tag_key) args.push("--tag-key", tag_key);
      return asResult(await runAws(args));
    } catch (err) {
      return asError(err);
    }
  }
);

/* ------------------------------------------------------------------ */
/* get_commitment_utilization                                          */
/* ------------------------------------------------------------------ */
server.tool(
  "get_commitment_utilization",
  "Get Savings Plans or Reserved Instance utilization and coverage for a time period. " +
    "Returns an explanatory message if the account has no such commitments.",
  {
    commitment_type: z.enum(["savings_plans", "reservations"]),
    report: z
      .enum(["utilization", "coverage"])
      .default("utilization")
      .describe("utilization = how much of the commitment was used; coverage = how much of eligible usage was covered"),
    start: dateSchema,
    end: dateSchema,
    granularity: z.enum(["DAILY", "MONTHLY"]).default("MONTHLY"),
  },
  async ({ commitment_type, report, start, end, granularity }) => {
    try {
      await ensureAccount();
      const cmd =
        commitment_type === "savings_plans"
          ? report === "utilization"
            ? "get-savings-plans-utilization"
            : "get-savings-plans-coverage"
          : report === "utilization"
            ? "get-reservation-utilization"
            : "get-reservation-coverage";
      return asResult(
        await runAws([
          "ce",
          cmd,
          "--time-period",
          `Start=${start},End=${end}`,
          "--granularity",
          granularity,
        ])
      );
    } catch (err) {
      if (/no.*(savings plan|reservation)/i.test(String(err.message))) {
        return asResult({
          Message: `Account ${EXPECTED_ACCOUNT} has no active ${commitment_type.replace("_", " ")} in this period.`,
        });
      }
      return asError(err);
    }
  }
);

/* ------------------------------------------------------------------ */

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `aws-billing-mcp ready (account ${EXPECTED_ACCOUNT}, aws cli: ${AWS_BIN})`
);
