#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { LinkedInClient } from "./linkedin-client.js";
import { requireCapability, CapabilityError } from "./agent-capability.js";
import { requireBrand, BrandError } from "./brand-gate.js";

const REQUIRED_CAPABILITY = "social"; // ECHO owns social posting
const SERVER_BRAND = "nas_digital"; // LinkedIn is the technical brand's channel

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
        task_id: {
          type: "string",
          description:
            "The board task this post belongs to. LinkedIn is a NAS DIGITAL channel - the " +
            "task's brand must be nas_digital, or the post is refused. With Nate work goes " +
            "to Instagram/Facebook/Threads/Pinterest/TikTok instead.",
        },
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
      required: ["agent_id", "task_id", "text"],
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

  try {
    switch (name) {
    case "linkedin_get_profile":
      result = await client.getUserInfo();
      break;
    case "linkedin_create_post":
      await requireCapability(args.agent_id as string | undefined, REQUIRED_CAPABILITY);
      // LinkedIn is NAS Digital's channel. Gated on the publishing call only:
      // uploading an image commits nothing publicly, and deleting a post is
      // always allowed (removing something is never the harmful direction).
      await requireBrand(args.task_id as string | undefined, SERVER_BRAND);
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
  } catch (err) {
    // A gate rejection is a real answer to the caller, not a crash. Thrown, it
    // surfaced as an opaque transport error and the agent could not tell a
    // wrong-brand refusal from LinkedIn being down - so it retried. Returned as
    // isError, the reason is readable and actionable.
    if (err instanceof BrandError || err instanceof CapabilityError) {
      return { content: [{ type: "text", text: err.message }], isError: true };
    }
    throw err;
  }

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("linkedin-mcp server running on stdio");
