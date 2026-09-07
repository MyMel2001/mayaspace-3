/**
 * Profile pages, editing (CSS customization with sanitization), avatars.
 */
import { Router, type Request, type Response } from "express";
import { store } from "../../store.js";
import { buildPostViews } from "../../services/render.js";
import { setAvatar, updateProfile } from "../../services/users.js";
import { processUpload } from "../../services/attachments.js";
import { avatarUpload } from "../upload.js";
import { requireLogin, csrfGuard, uploadLimiter } from "../../security/auth.js";
import { commonLocals, flash } from "../helpers.js";
import { config } from "../../config.js";

const router = Router();

async function profilePage(
  req: Request,
  res: Response,
  handle: string,
  isSelf: boolean,
): Promise<void> {
  const user = await store.getUser(handle);
  if (!user || user.suspended) {
    res.status(404).render("error", {
      ...(await commonLocals(req, res)),
      pageTitle: "User not found",
      message: "No such user. They may have been banned, or never existed.",
    });
    return;
  }
  const viewer = req.user;
  const isFriend = viewer ? await store.isFriend(viewer.handle, handle) : false;
  const hasPendingRequest =
    viewer !== undefined &&
    (await store.listPendingRequestsFrom(viewer.handle)).some((r) => r.toHandle === handle);
  const hasIncomingRequest =
    viewer !== undefined &&
    (await store.listPendingRequestsTo(viewer.handle)).some((r) => r.fromHandle === handle);
  const { items } = await store.listPosts({
    authorHandle: handle,
    viewerHandle: viewer?.handle,
    isFriendOf: async (h: string) => (viewer ? store.isFriend(viewer.handle, h) : false),
    limit: 30,
  });
  const posts = await buildPostViews(items, viewer);
  const friendCount = await store.friendCount(handle);
  const friends = await Promise.all(
    (await store.listFriends(handle)).slice(0, 8).map(async (h) => {
      const u = await store.getUser(h);
      return u && !u.suspended
        ? { handle: u.handle, displayName: u.displayName, avatarUrl: u.avatar ? `/media/${u.avatar}` : null }
        : null;
    }),
  );
  const pendingCount = isSelf ? (await store.listPendingRequestsTo(handle)).length : 0;

  res.render("profile", {
    ...(await commonLocals(req, res)),
    pageTitle: `${user.displayName} (${user.handle})`,
    profileUser: {
      handle: user.handle,
      displayName: user.displayName,
      avatarUrl: user.avatar ? `/media/${user.avatar}` : null,
      bioHtml: user.bioHtml,
      themeColor: user.themeColor,
      customCss: user.customCss,
      role: user.role,
      createdAt: user.createdAt,
    },
    posts,
    isSelf,
    isFriend,
    hasPendingRequest,
    hasIncomingRequest,
    friendCount,
    friends: friends.filter((f) => f !== null),
    pendingCount,
  });
}

router.get("/u/:handle", async (req: Request, res: Response) => {
  const handle = String(req.params.handle).toLowerCase();
  await profilePage(req, res, handle, req.user?.handle === handle);
});

router.get("/settings", requireLogin, async (req: Request, res: Response) => {
  const user = req.user!;
  res.render("settings", {
    ...(await commonLocals(req, res)),
    pageTitle: "Edit profile",
    instanceHost: new URL(config.mayaUrl).host,
    profileUser: {
      handle: user.handle,
      displayName: user.displayName,
      avatarUrl: user.avatar ? `/media/${user.avatar}` : null,
      bioHtml: user.bioHtml,
      themeColor: user.themeColor,
      customCss: user.customCss,
      role: user.role,
      createdAt: user.createdAt,
    },
    maxUploadMb: config.maxUploadMb,
    attachmentsPerPost: config.attachmentsPerPost,
  });
});

router.post("/settings", requireLogin, csrfGuard, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const result = await updateProfile(req.user!.handle, {
    displayName: typeof body.displayName === "string" ? body.displayName : "",
    bioRaw: typeof body.bio === "string" ? body.bio : "",
    themeColor: typeof body.themeColor === "string" ? body.themeColor : "",
    customCss: typeof body.customCss === "string" ? body.customCss : "",
  });
  if (!result.ok) {
    flash(req, "error", result.error ?? "Couldn't save profile.");
  } else {
    flash(req, "success", "Profile updated! Looking sharp.");
  }
  res.redirect(`/u/${req.user!.handle}`);
});

router.post(
  "/settings/avatar",
  requireLogin,
  uploadLimiter,
  avatarUpload,
  csrfGuard,
  async (req: Request, res: Response) => {
    const upload = (req as unknown as { file?: Express.Multer.File }).file;
    if (!upload) {
      flash(req, "error", "Choose an image first.");
      res.redirect("/settings");
      return;
    }
    const result = await processUpload(req.user!, upload);
    if (!result.ok || !result.attachment) {
      flash(req, "error", result.error ?? "Upload failed.");
      res.redirect("/settings");
      return;
    }
    await setAvatar(req.user!.handle, result.attachment.filename);
    flash(req, "success", "Avatar updated!");
    res.redirect(`/u/${req.user!.handle}`);
  },
);

export default router;