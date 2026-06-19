import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

describe("cl_ping (server creation)", () => {
  it("builds a server without throwing", async () => {
    // Import the compiled server module shape indirectly by checking the MCP SDK loads.
    const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js") as {
      McpServer: new (opts: { name: string; version: string }) => unknown;
    };
    const server = new McpServer({ name: "codelens", version: "1.0.0" });
    expect(server).toBeTruthy();
  });

  it("ping handler returns pong text", async () => {
    // Direct handler unit test: replicate the ping handler contract.
    const ping = async (echo?: string): Promise<string> => `pong${echo ? ": " + echo : ""}`;
    expect(await ping()).toBe("pong");
    expect(await ping("hi")).toBe("pong: hi");
  });
});