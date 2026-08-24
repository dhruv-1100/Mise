import { handlers } from "@/auth";

/**
 * Every OAuth endpoint Auth.js needs: /signin, /callback, /signout, /session,
 * /csrf. Exported wholesale rather than enumerated, because the set is the
 * library's contract and a partial re-export fails at runtime with a 404 that
 * looks like a Google configuration problem.
 */
export const { GET, POST } = handlers;
