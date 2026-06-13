import { generateDummyPassword } from "./db/utils";

export const isProductionEnvironment = process.env.NODE_ENV === "production";
export const isDevelopmentEnvironment = process.env.NODE_ENV === "development";
export const isTestEnvironment = Boolean(
  process.env.PLAYWRIGHT_TEST_BASE_URL ||
    process.env.PLAYWRIGHT ||
    process.env.CI_PLAYWRIGHT
);

const truthyEnvValues = new Set(["1", "true", "yes", "on"]);
const falsyEnvValues = new Set(["0", "false", "no", "off"]);

export function shouldUseSecureAuthCookies() {
  const explicitValue = process.env.AUTH_SECURE_COOKIES?.toLowerCase();

  if (explicitValue && truthyEnvValues.has(explicitValue)) {
    return true;
  }

  if (explicitValue && falsyEnvValues.has(explicitValue)) {
    return false;
  }

  const siteUrl =
    process.env.AUTH_URL ??
    process.env.NEXTAUTH_URL ??
    process.env.NEXT_PUBLIC_SITE_URL;

  if (siteUrl?.startsWith("http://")) {
    return false;
  }

  if (siteUrl?.startsWith("https://")) {
    return true;
  }

  return !isDevelopmentEnvironment;
}

export const guestRegex = /^guest-\d+$/;

export const DUMMY_PASSWORD = generateDummyPassword();

export const suggestions = [
  "What are the advantages of using Next.js?",
  "Write code to demonstrate Dijkstra's algorithm",
  "Help me write an essay about Silicon Valley",
  "What is the weather in San Francisco?",
];
