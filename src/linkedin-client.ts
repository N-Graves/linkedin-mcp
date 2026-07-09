const BASE_URL = "https://api.linkedin.com";
// LinkedIn requires a YYYYMM version header on every /rest/* call - bump this
// periodically (LinkedIn's own docs recommend staying within ~1 year of current).
const LINKEDIN_VERSION = "202506";

interface UserInfo {
  sub: string;
  name?: string;
  email?: string;
}

interface CreatePostArgs {
  text: string;
  visibility?: "PUBLIC" | "CONNECTIONS";
}

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

    const body = {
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
    return { postUrn, raw };
  }
}
