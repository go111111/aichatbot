import { type NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { guestRegex, shouldUseSecureAuthCookies } from "./lib/constants";

const secureSessionCookieName = "__Secure-authjs.session-token";
const sessionCookieName = "authjs.session-token";

async function getSessionToken(request: NextRequest) {
  const secret = process.env.AUTH_SECRET;

  if (!secret) {
    return null;
  }

  const preferredCookieName = shouldUseSecureAuthCookies()
    ? secureSessionCookieName
    : sessionCookieName;

  const fallbackCookieName =
    preferredCookieName === sessionCookieName
      ? secureSessionCookieName
      : sessionCookieName;

  for (const cookieName of [preferredCookieName, fallbackCookieName]) {
    const token = await getToken({
      req: request,
      secret,
      cookieName,
      salt: cookieName,
      secureCookie: cookieName === secureSessionCookieName,
    });

    if (token) {
      return token;
    }
  }

  return null;
}

function hasSessionCookie(request: NextRequest) {
  return Boolean(
    request.cookies.get(sessionCookieName)?.value ||
      request.cookies.get(secureSessionCookieName)?.value
  );
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/ping")) {
    return new Response("pong", { status: 200 });
  }

  if (pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }

  if (!process.env.POSTGRES_URL) {
    return NextResponse.next();
  }

  const token = await getSessionToken(request);

  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

  if (!token && !hasSessionCookie(request)) {
    const redirectUrl = encodeURIComponent(new URL(request.url).pathname);

    return NextResponse.redirect(
      new URL(`${base}/api/auth/guest?redirectUrl=${redirectUrl}`, request.url)
    );
  }

  const isGuest = guestRegex.test(token?.email ?? "");

  if (token && !isGuest && ["/login", "/register"].includes(pathname)) {
    return NextResponse.redirect(new URL(`${base}/`, request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/",
    "/chat/:id",
    "/api/:path*",
    "/login",
    "/register",

    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
