#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { LinkedInClient } from "./linkedin-client.js";

const ACCESS_TOKEN = process.env.LINKEDIN_ACCESS_TOKEN;
if (!ACCESS_TOKEN) {
  console.error("LINKEDIN_ACCESS_TOKEN environment variable is required");
  process.exit(1);
}

const client = new LinkedInClient(ACCESS_TOKEN);

const tools: Tool[] = [
  {
    name: "linkedin_get_profile",
    description: "Get the authenticated LinkedIn user's basic profile (name, email, member id)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "linkedin_create_post",
    description:
      "Publish a real, immediately-live post to LinkedIn. There is no draft/undo - only call this after the " +
      "content has already been approved through the fleet board's HITL review, never before.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The post text (LinkedIn's commentary field)" },
        visibility: { type: "string", enum: ["PUBLIC", "CONNECTIONS"], description: "Default PUBLIC" },
      },
      required: ["text"],
    },
  },
];

const server = new Server({ name: "linkedin-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  let result: unknown;

  switch (name) {
    case "linkedin_get_profile":
      result = await client.getUserInfo();
      break;
    case "linkedin_create_post":
      result = await client.createPost({
        text: args.text as string,
        visibility: args.visibility as "PUBLIC" | "CONNECTIONS" | undefined,
      });
      break;
    default:
      throw new Error(`Unknown tool: ${name}`);
  }

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("linkedin-mcp server running on stdio");
