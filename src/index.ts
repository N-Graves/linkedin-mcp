#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { LinkedInClient } from "./linkedin-client.js";
import { requireCapability } from "./agent-capability.js";

const REQUIRED_CAPABILITY = "social"; // ECHO owns social posting

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
      "content has already been approved through the fleet board's HITL review, never before. Requires " +
      "agent_id (must hold the 'social' capability, e.g. echo).",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Your fleet-board agent id, e.g. 'echo'" },
        text: { type: "string", description: "The post text (LinkedIn's commentary field)" },
        visibility: { type: "string", enum: ["PUBLIC", "CONNECTIONS"], description: "Default PUBLIC" },
        image_path: {
          type: "string",
          description:
            "Local image file path (png/jpg/gif) to attach. Uploaded to LinkedIn first, so give a " +
            "local path (e.g. a MUSE render), NOT a public URL.",
        },
        image_alt_text: {
          type: "string",
          description: "Alt text for the attached image - include it, for accessibility and reach.",
        },
      },
      required: ["agent_id", "text"],
    },
  },
  {
    name: "linkedin_upload_image",
    description:
      "Upload one local image to LinkedIn and return its image URN, without posting anything. Useful to " +
      "verify an image is accepted before composing the post. Most callers should just pass image_path to " +
      "linkedin_create_post instead. Requires agent_id (must hold the 'social' capability).",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Your fleet-board agent id, e.g. 'echo'" },
        image_path: { type: "string", description: "Local path to a png/jpg/gif" },
      },
      required: ["agent_id", "image_path"],
    },
  },
  {
    name: "linkedin_delete_post",
    description:
      "Delete one of our own LinkedIn posts. Irreversible - the post and its engagement are gone. Takes " +
      "the post URN returned by linkedin_create_post. Requires agent_id (must hold the 'social' " +
      "capability). NOTE: there is deliberately no 'list my posts' tool - reading your own posts back " +
      "needs the r_member_social scope, which this token does not hold and which LinkedIn restricts to " +
      "approved partners. Keep the URN from the create call if you may need to delete it.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Your fleet-board agent id, e.g. 'echo'" },
        post_urn: {
          type: "string",
          description: "The post URN, e.g. urn:li:share:7123456789 (returned by linkedin_create_post)",
        },
      },
      required: ["agent_id", "post_urn"],
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
      await requireCapability(args.agent_id as string | undefined, REQUIRED_CAPABILITY);
      result = await client.createPost({
        text: args.text as string,
        visibility: args.visibility as "PUBLIC" | "CONNECTIONS" | undefined,
        imagePath: args.image_path as string | undefined,
        imageAltText: args.image_alt_text as string | undefined,
      });
      break;
    case "linkedin_upload_image":
      await requireCapability(args.agent_id as string | undefined, REQUIRED_CAPABILITY);
      result = { image_urn: await client.uploadImage(args.image_path as string) };
      break;
    case "linkedin_delete_post":
      await requireCapability(args.agent_id as string | undefined, REQUIRED_CAPABILITY);
      result = await client.deletePost(args.post_urn as string);
      break;
    default:
      throw new Error(`Unknown tool: ${name}`);
  }

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("linkedin-mcp server running on stdio");
