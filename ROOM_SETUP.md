# Room sync setup (Firebase)

Solo mode works with no backend. **Room** mode (multi-device live sync) uses a free **Firebase** project (Spark plan).

Home-game traffic is tiny compared to Firebase free quotas. If you previously used Supabase and hit org/project limits, start a new Firebase project instead.

## 1. Create a Firebase project

1. Open [Firebase Console](https://console.firebase.google.com/)
2. **Add project** (Google Analytics optional)
3. **Project settings → Your apps → Web (`</>`)** → register app → copy the config object

## 2. Enable Anonymous Auth

1. **Build → Authentication → Get started**
2. **Sign-in method → Anonymous → Enable → Save**

## 3. Create Firestore

1. **Build → Firestore Database → Create database**
2. Start in **production mode**
3. Pick a region close to your players

## 4. Publish security rules

1. Open **Firestore → Rules**
2. Replace everything with the contents of [`firestore.rules`](firestore.rules)
3. **Publish**

Or with CLI:

```bash
npm install -g firebase-tools
firebase login
firebase init firestore   # use this repo's firestore.rules
firebase deploy --only firestore:rules
```

## 5. Fill in client config

Edit `firebase-config.js`:

```js
window.FIREBASE_CONFIG = {
    apiKey: '…',
    authDomain: '….firebaseapp.com',
    projectId: '…',
    storageBucket: '….appspot.com',
    messagingSenderId: '…',
    appId: '…'
};
```

Web config is public; access control is Auth + Firestore rules. Leave `apiKey` empty for solo-only mode.

## 6. Verify

1. Open the app on device A → **Room → Create room** → note the code
2. Device B → **Room → Join** with the code
3. B is **view only**; on A open **People → Allow edit** for B
4. Edits should appear on the other device within about a second

## How it works

| Concept | Behavior |
|--------|----------|
| Solo | `localStorage` only (unchanged) |
| Room | One Firestore doc per room + live `onSnapshot` |
| Auth | Anonymous (`auth.uid`) |
| Host | Creator; edit; grant/revoke; end room (ending drops the host back to solo with the final numbers) |
| Editor | Can edit stacks like host |
| Viewer | Live read-only table |
| Code | 5-char code in `roomCodes/{code}` → `rooms/{id}` |
| Solo data | Joining stashes your solo session. Leaving an **active** room restores that backup. After a room **ends**, devices keep the final shared snapshot as solo and discard the backup. |
| SDK | Firebase scripts load on demand, so solo mode still starts offline |

## Optional deep link

`https://yoursite/Poker-Stack-Tracker/?room=ABC12` prefills the join code.

## Cost / limits

Firebase **Spark (free)** is enough for casual home games (occasional rooms, a handful of devices). Ending a room marks it `ended` and deletes the short code so new joins fail; the `rooms/{id}` document is kept so participants can still see final numbers until they leave.

## Migrating from Supabase

1. You can ignore or delete Supabase project credentials
2. Use `firebase-config.js` + `firestore.rules` (this doc)
3. Old `supabase-config.js` / `supabase/schema.sql` are no longer used by the app
