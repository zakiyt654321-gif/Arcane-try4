# Arcane Royale Firestore & RTDB Security Specification

## 1. Data Invariants
1. **Strict Ownership & Non-PII Profiles (`/users/{userId}`)**: Only `request.auth.uid == userId` may create, update, or delete their profile document. `users/{userId}` contains zero PII (no email, phone, or device tokens). Public reads/list queries require `isSignedIn() && resource.data.isPublic == true` to power the Global Top-50 Leaderboard and Champion Name friend search safely.
2. **Immutable Unique Friend Codes (`/friendCodes/{code}`)**: Friend codes match `^ARC-[A-HJ-NP-Z2-9]{4}$`, can only be created once (`!exists(...)`) with `uid == request.auth.uid`, and can never be modified or deleted.
3. **Sender-Bound Friend Requests (`/users/{userId}/friendRequests/{fromUid}`)**: Only `request.auth.uid == fromUid` (where `userId != fromUid`) may create a friend request; only `userId` or `fromUid` may read or delete it.
4. **Mutual Atomic Friendships (`/users/{userId}/friends/{friendUid}`)**: Only `userId` may list/read their friends; only `userId` or `friendUid` (for mutual accept/unfriend `writeBatch`) may write or delete the mutual edge.
5. **Anti-Tamper Validation**: `displayName` is restricted to `3..12` alphanumeric/underscore characters, `level` to `1..100`, `coins`/`crystals`/`gems`/`xp` non-negative integers within bounds, `selectedChampion` within `['BERSERKER', 'TIDECALLER', 'SHADOW']`, and `createdAt`/`updatedAt` strictly equal `request.time`.
6. **Realtime Database Guardrails (`database.rules.json`)**: `presence/{uid}` writable only by `auth.uid == uid`; `invites/{targetUid}/{squadId}` readable/deletable by `targetUid` and creatable only when `fromUid == auth.uid`; `squads/{squadId}` member writes restricted to `auth.uid == memberUid` or `leaderUid`; `matches/{matchId}` `bots` & `world` writable only by `hostUid`, `players/{uid}` only by `auth.uid == uid`, and `hostUid` transition permitted only when current host is disconnected.

## 2. The "Dirty Dozen" Adversarial Payloads (Must Return PERMISSION_DENIED)
1. **Cross-User Profile Write**: User `uid_B` attempts to update `/users/uid_A`.
2. **Identity Spoofing**: User `uid_B` creates `/users/uid_B` with `{ uid: "uid_A" }`.
3. **Friend Code Hijack**: User `uid_B` overwrites or claims an already-existing `/friendCodes/ARC-K9M2`.
4. **Friend Code Impersonation**: User `uid_B` creates `/friendCodes/ARC-7X4P` pointing to `{ uid: "uid_A" }`.
5. **Shadow Field Injection**: User `uid_A` injects `{ isAdmin: true }` into `/users/uid_A`.
6. **Negative Currency / Overflow**: User `uid_A` writes `coins: -500` or `level: 999`.
7. **Invalid Champion Name Length**: User `uid_A` writes `displayName: "A"` (< 3 chars) or `"WayTooLongChampionName"` (> 12 chars).
8. **Spoofed Friend Request**: User `uid_B` creates `/users/uid_C/friendRequests/uid_A` pretending to be `uid_A`.
9. **Self Friend Request**: User `uid_A` creates `/users/uid_A/friendRequests/uid_A`.
10. **Third-Party Friend Injection**: User `uid_C` writes `/users/uid_A/friends/uid_B`.
11. **Backdated Timestamp Forgery**: User `uid_A` submits a client timestamp instead of `serverTimestamp()`.
12. **Unauthenticated Access**: Unauthenticated client (`request.auth == null`) reads or writes any collection.
