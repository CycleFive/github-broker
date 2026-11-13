export interface Env {
  /** KV namespace the OAuth library keeps clients, grants and tokens in. */
  OAUTH_KV: KVNamespace;

  /** This Worker's public origin, e.g. https://github-broker.example.workers.dev (no trailing slash). */
  PUBLIC_URL: string;

  /** GitHub App client ID (Iv23...). JWT issuer and "Sign in with GitHub" client. Not secret. */
  GITHUB_APP_CLIENT_ID: string;
  /** Installation of the app on the org. Not secret. */
  GITHUB_INSTALLATION_ID: string;
  /** Optional: owner used when a tool gets "repo" without an owner. */
  GITHUB_DEFAULT_OWNER?: string;
  /** GitHub user IDs (preferred) or logins allowed to sign in, comma-separated. */
  ALLOWED_GITHUB_USERS: string;
  /** Optional: comma-separated Origins the MCP endpoint accepts when an Origin header is present. */
  ALLOWED_ORIGINS?: string;

  /** Secret: the app's private key PEM (PKCS#1 as GitHub issues it, or PKCS#8). */
  GITHUB_APP_PRIVATE_KEY: string;
  /** Secret: the app's client secret, for the sign-in code exchange. */
  GITHUB_APP_CLIENT_SECRET: string;
}
