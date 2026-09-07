/**
 * Notification assembly: turns stored records into view models with links,
 * actor info, and relative times.
 */
import { store } from "../store.js";
import type { NotificationRecord, NotificationView } from "../types.js";
import { timeAgo } from "../util.js";
import { authorViewForLocal, authorViewForRemote } from "./render.js";

export async function buildNotificationViews(
  records: NotificationRecord[],
): Promise<NotificationView[]> {
  const views: NotificationView[] = [];
  for (const n of records) {
    let actor = null as NotificationView["actor"];
    if (n.actorHandle) {
      actor = await authorViewForLocal(n.actorHandle);
    } else if (n.remoteActorId) {
      const ra = await store.getRemoteActor(n.remoteActorId);
      if (ra) actor = authorViewForRemote(ra);
    }
    const link =
      n.commentId && n.postId
        ? `/post/${n.postId}#comment-${n.commentId}`
        : n.postId
          ? `/post/${n.postId}`
          : n.type === "friend_request" || n.type === "friend_accept"
            ? "/friends"
            : "/notifications";
    views.push({
      id: n.id,
      type: n.type,
      message: n.message ?? "",
      link,
      timeAgo: timeAgo(n.createdAt),
      read: n.read,
      actor,
    });
  }
  return views;
}