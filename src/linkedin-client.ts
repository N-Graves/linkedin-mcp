import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

const BASE_URL = "https://api.linkedin.com";
// LinkedIn requires a YYYYMM version header on every /rest/* call, and retires
// versions after roughly a year. This was pinned at 202506 and had gone stale:
// every /rest/* call was failing with 426 NONEXISTENT_VERSION, which means post
// creation was broken too, not just the image upload that surfaced it
// (2026-07-26). Verified live that 202606 works; 202512 is already retired, so
// "roughly a year" is not a guarantee - re-check if 426s reappear.
const LINKEDIN_VERSION = "202606";

interface UserInfo {
  sub: string;
  name?: string;
  email?: string;
}

interface CreatePostArgs {
  text: string;
  visibility?: "PUBLIC" | "CONNECTIONS";
  /** Local image file path to attach. Uploaded before the post is created. */
  imagePath?: string;
  /** Alt text / title for the attached image. */
  imageAltText?: string;
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
};

export class LinkedInClient {
  constructor(private readonly accessToken: string) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async getUserInfo(): Promise<UserInfo> {
    const res = await fetch(`${BASE_URL}/v2/userinfo`, { headers: this.headers() });
    if (!res.ok) throw new Error(`getUserInfo failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<UserInfo>;
  }

  /**
   * Creates a real, immediately-live LinkedIn post. LinkedIn's Posts API has
   * no draft/unpublished lifecycle state to fall back on - the HITL approval
   * gate MUST happen before this is ever called, not after. Callers should
   * never invoke this directly from a draft-review flow.
   */
  async createPost(args: CreatePostArgs): Promise<{ postUrn: string | null; raw: unknown }> {
    const me = await this.getUserInfo();
    const authorUrn = `urn:li:person:${me.sub}`;

    // Upload first: an image that LinkedIn rejects should fail before anything
    // is published, since a LinkedIn post cannot be edited to add media later.
    let imageUrn: string | null = null;
    if (args.imagePath) {
      imageUrn = await this.uploadImage(args.imagePath, authorUrn);
    }

    const body: Record<string, unknown> = {
      author: authorUrn,
      commentary: args.text,
      visibility: args.visibility ?? "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };

    if (imageUrn) {
      body.content = {
        media: {
          id: imageUrn,
          ...(args.imageAltText ? { altText: args.imageAltText } : {}),
        },
      };
    }

    const res = await fetch(`${BASE_URL}/rest/posts`, {
      method: "POST",
      headers: this.headers({
        "X-Restli-Protocol-Version": "2.0.0",
        "LinkedIn-Version": LINKEDIN_VERSION,
      }),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`createPost failed: ${res.status} ${await res.text()}`);
    }

    // LinkedIn returns the new post's URN in the x-restli-id response header,
    // not the (usually empty) response body.
    const postUrn = res.headers.get("x-restli-id");
    let raw: unknown = null;
    try {
      raw = await res.json();
    } catch {
      // Empty body is normal for a successful create.
    }
    return { postUrn, raw, imageUrn } as { postUrn: string | null; raw: unknown; imageUrn?: string | null };
  }

  /**
   * Uploads a local image and returns its image URN, ready to attach to a post.
   *
   * LinkedIn's Images API is a three-step dance: initializeUpload returns a
   * single-use uploadUrl plus the URN the image WILL have, the bytes are PUT to
   * that URL, and only then is the URN usable in a post. The URN is handed back
   * before the upload completes, so it must not be used until the PUT returns.
   */
  async uploadImage(filePath: string, ownerUrn?: string): Promise<string> {
    const owner = ownerUrn ?? `urn:li:person:${(await this.getUserInfo()).sub}`;
    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_BY_EXT[ext];
    if (!contentType) {
      throw new Error(
        `unsupported image type ${ext || "(none)"} for ${basename(filePath)} - ` +
          `LinkedIn accepts ${Object.keys(MIME_BY_EXT).join(", ")}`,
      );
    }
    const bytes = await readFile(filePath);

    const initRes = await fetch(`${BASE_URL}/rest/images?action=initializeUpload`, {
      method: "POST",
      headers: this.headers({
        "X-Restli-Protocol-Version": "2.0.0",
        "LinkedIn-Version": LINKEDIN_VERSION,
      }),
      body: JSON.stringify({ initializeUploadRequest: { owner } }),
    });
    if (!initRes.ok) {
      throw new Error(`image initializeUpload failed: ${initRes.status} ${await initRes.text()}`);
    }
    const init = (await initRes.json()) as { value: { uploadUrl: string; image: string } };

    // The upload URL is pre-signed but still wants the bearer token; it is NOT
    // a /rest/* call, so it takes no LinkedIn-Version header.
    const putRes = await fetch(init.value.uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": contentType,
      },
      body: new Uint8Array(bytes),
    });
    if (!putRes.ok) {
      throw new Error(`image upload PUT failed: ${putRes.status} ${await putRes.text()}`);
    }

    return init.value.image;
  }

  /*
   * There is deliberately NO comment tool here, and this is not an oversight.
   *
   * It matters because LinkedIn heavily suppresses reach on posts carrying an
   * external URL in the body, so the product link is supposed to go in the
   * first comment. We built the socialActions call and probed it live
   * (2026-07-27), against a non-existent share URN so nothing was created:
   *
   *   POST /rest/socialActions/{urn}/comments
   *     -> 403 ACCESS_DENIED "Not enough permissions to access:
   *        partnerApiSocialActions.CREATE.20260601"
   *   GET  /rest/socialActions/{urn}/comments
   *     -> 403 ACCESS_DENIED "...partnerApiSocialActions.GET_ALL.20260601"
   *
   * Both directions are gated behind the LinkedIn Partner Program, NOT behind a
   * scope we could add at re-auth - the token already holds w_member_social,
   * which LinkedIn's own docs describe as covering comments. It does not, for a
   * standard app.
   *
   * So on LinkedIn the follow-up comment is a manual step for Nathan. ECHO puts
   * the exact comment text in its HITL note; see ECHO's AGENTS.md. Don't
   * re-derive this - the probe above is the answer.
   */

  /** Deletes one of our own posts. Irreversible. */
  async deletePost(postUrn: string): Promise<{ deleted: boolean }> {
    const res = await fetch(`${BASE_URL}/rest/posts/${encodeURIComponent(postUrn)}`, {
      method: "DELETE",
      headers: this.headers({
        "X-Restli-Protocol-Version": "2.0.0",
        "LinkedIn-Version": LINKEDIN_VERSION,
      }),
    });
    if (!res.ok) {
      throw new Error(`deletePost failed: ${res.status} ${await res.text()}`);
    }
    return { deleted: true };
  }
}
