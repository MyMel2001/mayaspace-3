/**
 * Home feed (public + friends' posts), welcome page, search, health check.
 */
import { Router, type Request, type Response } from "express";
import { config } from "../../config.js";
import { store } from "../../store.js";
import { buildPostViews } from "../../services/render.js";
import { commonLocals } from "../helpers.js";

const router = Router();

router.get("/", async (req: Request, res: Response) => {
  const viewer = req.user;
  const { items } = await store.listPosts({
    viewerHandle: viewer?.handle,
    isFriendOf: async (h: string) => (viewer ? store.isFriend(viewer.handle, h) : false),
    limit: 20,
    cursor: typeof req.query.cursor === "string" ? req.query.cursor : null,
  });
  const posts = await buildPostViews(items, viewer);
  const stats = await store.stats();
  res.render("home", {
    ...(await commonLocals(req, res)),
    pageTitle: null,
    posts,
    stats,
  });
});

router.get("/welcome", async (req: Request, res: Response) => {
  res.render("welcome", {
    ...(await commonLocals(req, res)),
    pageTitle: "Welcome",
    instanceHost: new URL(config.mayaUrl).host,
  });
});

router.get("/search", async (req: Request, res: Response) => {
  const q = typeof req.query.q === "string" ? req.query.q.slice(0, 100) : "";
  const users = q === "" ? [] : (await store.searchUsers(q)).map((u) => ({
    handle: u.handle,
    displayName: u.displayName,
    avatarUrl: u.avatar ? `/media/${u.avatar}` : null,
    role: u.role,
  }));
  res.render("search", {
    ...(await commonLocals(req, res)),
    pageTitle: "Search",
    q,
    users,
  });
});

router.get("/healthz", (_req: Request, res: Response) => {
  res.type("text/plain").send("ok");
});

export default router;