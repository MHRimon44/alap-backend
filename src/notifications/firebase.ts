import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';

export type FirebaseConfig = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
};

export function initializeFirebase(config: FirebaseConfig): void {
  if (getApps().some((app) => app.name === '[DEFAULT]')) {
    return;
  }

  initializeApp({
    credential: cert({
      projectId: config.projectId,
      clientEmail: config.clientEmail,
      privateKey: config.privateKey,
    }),
  });
}

export function firebaseMessaging(): Messaging {
  return getMessaging();
}
