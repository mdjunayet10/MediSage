import {
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { db } from "./firebase.js";

export async function loadCloudConversations(uid) {
  if (!db || !uid) return [];
  const snapshot = await getDocs(
    query(
      collection(db, "users", uid, "conversations"),
      orderBy("updatedAt", "desc"),
    ),
  );
  return snapshot.docs.map((item) => item.data()).filter((item) => item?.id);
}

export async function saveCloudConversation(uid, conversation) {
  if (!db || !uid || !conversation?.id) return;
  const serializable = JSON.parse(JSON.stringify(conversation));
  serializable.attachments = (serializable.attachments || []).map(
    ({ chunks: _chunks, ...attachment }) => ({
      ...attachment,
      localContextAvailable: false,
    }),
  );
  await setDoc(
    doc(db, "users", uid, "conversations", conversation.id),
    {
      ...serializable,
      document: serializable.document
        ? { ...serializable.document, summary: null }
        : null,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}
