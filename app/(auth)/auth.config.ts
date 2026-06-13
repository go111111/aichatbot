import type { NextAuthConfig } from "next-auth";
import { shouldUseSecureAuthCookies } from "@/lib/constants";

const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const authConfig = {
  basePath: "/api/auth",
  trustHost: true,
  useSecureCookies: shouldUseSecureAuthCookies(),
  pages: {
    signIn: `${base}/login`,
    newUser: `${base}/`,
  },
  providers: [],
  callbacks: {},
} satisfies NextAuthConfig;
