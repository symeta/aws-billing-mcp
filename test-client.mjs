import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["index.mjs"] });
const client = new Client({ name: "test", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map(t => t.name).join(", "));

const res = await client.callTool({
  name: "get_cost_and_usage",
  arguments: {
    start: "2026-08-01", end: "2026-08-19", granularity: "MONTHLY",
    metrics: ["UnblendedCost"],
    group_by: [{ type: "DIMENSION", key: "SERVICE" }]
  }
});
const data = JSON.parse(res.content[0].text);
const groups = data.ResultsByTime[0].Groups
  .map(g => [g.Keys[0], parseFloat(g.Metrics.UnblendedCost.Amount)])
  .sort((a, b) => b[1] - a[1]).slice(0, 5);
console.log("TOP5 SERVICES:", JSON.stringify(groups, null, 1));

const fc = await client.callTool({ name: "get_cost_forecast", arguments: { start: "2026-08-19", end: "2026-09-01" } });
console.log("FORECAST:", fc.content[0].text.slice(0, 300));

await client.close();
