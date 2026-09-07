/**
 * Notification list + mark-as-read.
 */
import { Router, type Request, type Response } from "express";
import { store } from "../../store.js";
import { buildNotificationViews } from "../../services/notifications.js";
import { csrfGuard, requireLogin } from "../../security/auth.js";
import { commonLocals, flash } from "../helpers.js";

const router = Router();

router.get("/notifications", requireLogin, async (req: Request, res: Response) => {
  const records = await store.listNotifications(req.user!.handle, 50);
  const views = await buildNotificationViews(records);
  const unread = views.filter((v) => !v.read).length;
  res.render("notifications", {
    ...(await commonLocals(req, res)),
    pageTitle: "Notifications",
    notifications: views,
    unread,
  });
});

router.post("/notifications/read", requireLogin, csrfGuard, async (req: Request, res: Response) => {
  await store.markNotificationsRead(req.user!.handle);
  flash(req, "info", "All caught up!");
  res.redirect("/notifications");
});

export default router;