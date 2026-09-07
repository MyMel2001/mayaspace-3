/**
 * Registration, login, logout, password change. Every POST is CSRF-guarded
 * and rate-limited; all user input is validated server-side.
 */
import { Router, type Request, type Response } from "express";
import { authenticate, changePassword, registerUser } from "../../services/users.js";
import { authLimiter, csrfGuard, requireLogin } from "../../security/auth.js";
import { commonLocals, flash } from "../helpers.js";
import { getActorKeyPairs } from "../../fediverse/keys.js";

const router = Router();

router.get("/register", async (req: Request, res: Response) => {
  if (req.user) {
    res.redirect("/");
    return;
  }
  res.render("register", { ...(await commonLocals(req, res)), pageTitle: "Join" });
});

router.post("/register", authLimiter, csrfGuard, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const handle = typeof body.handle === "string" ? body.handle : "";
  const displayName = typeof body.displayName === "string" ? body.displayName : "";
  const email = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";

  const result = await registerUser({ handle, displayName, email, password });
  if (!result.ok || !result.user) {
    flash(req, "error", result.error ?? "Registration failed.");
    res.redirect("/register");
    return;
  }
  // Provision fediverse keys eagerly so the actor is ready to federate.
  await getActorKeyPairs(result.user.handle);
  req.session.userId = result.user.id;
  req.session.handle = result.user.handle;
  flash(req, "success", `Welcome to MayaSpace, ${result.user.displayName}!`);
  res.redirect("/welcome");
});

router.get("/login", async (req: Request, res: Response) => {
  if (req.user) {
    res.redirect("/");
    return;
  }
  res.render("login", { ...(await commonLocals(req, res)), pageTitle: "Log in" });
});

router.post("/login", authLimiter, csrfGuard, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const handle = typeof body.handle === "string" ? body.handle : "";
  const password = typeof body.password === "string" ? body.password : "";
  const result = await authenticate(handle, password);
  if (!result.ok || !result.user) {
    flash(req, "error", result.error ?? "Login failed.");
    res.redirect("/login");
    return;
  }
  // Rotate the session ID on privilege change (session fixation defense).
  const returnTo = req.session.returnTo;
  await new Promise<void>((resolve) =>
    req.session.regenerate((err) => {
      if (err) console.error("[login] session regeneration failed:", err);
      resolve();
    }),
  );
  req.session.userId = result.user.id;
  req.session.handle = result.user.handle;
  if (typeof returnTo === "string" && returnTo.startsWith("/") && !returnTo.startsWith("//")) {
    res.redirect(returnTo);
  } else {
    res.redirect("/");
  }
});

router.post("/logout", requireLogin, (_req: Request, res: Response) => {
  res.redirect("/");
});

router.get("/logout", async (req: Request, res: Response) => {
  req.session.userId = undefined;
  req.session.handle = undefined;
  await new Promise<void>((resolve) =>
    req.session.destroy(() => resolve()),
  );
  res.clearCookie("mayaspace.sid");
  res.redirect("/");
});

router.get("/password", requireLogin, async (req: Request, res: Response) => {
  res.render("password", { ...(await commonLocals(req, res)), pageTitle: "Change password" });
});

router.post("/password", requireLogin, authLimiter, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const next = typeof body.newPassword === "string" ? body.newPassword : "";
  const confirm = typeof body.confirmPassword === "string" ? body.confirmPassword : "";
  if (next !== confirm) {
    flash(req, "error", "New passwords don't match.");
    res.redirect("/password");
    return;
  }
  const result = await changePassword(req.user!.handle, current, next);
  if (!result.ok) {
    flash(req, "error", result.error ?? "Couldn't change password.");
  } else {
    flash(req, "success", "Password changed.");
  }
  res.redirect("/password");
});

export default router;