# Poker Stack Tracker

![Poker Stack Tracker Dark Mode](Poker_Stack_Tracker_Dark.png)

A minimalist web application for tracking chip stacks during poker games.

## Features

- **Blind Structure**: Set small and big blind amounts, or pick a 0.5/1, 1/2, 1/3, 2/5 preset (sets the default stack too)
- **Rake**: Mark a session as no-rake or rake (time, pot % with cap, flat fee, or a custom note). Chosen when creating a room and from the session chip in solo
- **Sign-in**: When Firebase is configured, Google or email is required before home. Continue with Google uses your Google session (no extra email code; Google already verified it). A Gmail password typed into the email form will not work. Create an email account with a unique display name, then verify the email before home unlocks. If that Gmail already has a password, Google asks you to sign in with the password once to connect. Google users pick a display name if they do not have one yet. You can change it later in Settings. Nobody else can use that name until you change it
- **Player Management**: Add players with their buy-in amounts. Tap a player's total buy-in to type a new amount
- **Dealer and Host**: Always-on house rows (default $0, never negative) for tips and host pay. Count toward cash balance, not player count
- **Stack Tracking**: Tap a player's total buy-in to type a new amount, plus undo for the last buy-in change
- **Cash Out Tracking**: Record cash-out amounts for each player
- **P&L Calculation**: Automatic profit and loss calculation per player
- **Balance Overview**: Buy-ins, player cash-outs, house take, and leftover
- **Settlement**: Who pays whom after cash-out, including Dealer and Host. Tick Paid when cash has changed hands. Copy the results for WhatsApp. Chop leftover among winners by P&L share so the books close
- **Session clock**: Start, pause (becomes Resume), and reset elapsed time (used for time-rake hints)
- **Action clock**: Header clock button opens a full-screen countdown (30s, 60s, 120s, or custom; default 60s) when a player is on the clock
- **Data Persistence**: Automatically saves game state to browser localStorage
- **Rooms (multi-device sync)**: After sign-in, home lists Solo (this device only) plus rooms you created or joined that have not expired. Create a 4-digit room code so other phones join the same live session; the room host edits by default and can grant edit access. Seat someone already in the room from Add Player. One account can host 3 rooms at a time; each room is deleted after 1 week. **Rooms** on the table goes back to home without leaving. **Leave** and **End room** stay in the room panel.
- **Responsive Design**: Works on desktop and mobile devices
- **Progressive Web App (PWA)**: Installable as a native app on your phone
- **Offline Support**: Works offline with service worker caching (solo mode)
- **Dark/Light Mode**: Toggle between dark and light themes
- **Compact Mode**: Toggle between normal and compact font sizes

## Rooms (optional)

If `firebase-config.js` is empty, skip login: home still shows with only Solo (create/join hidden). When Firebase is filled in:

1. Follow **[ROOM_SETUP.md](ROOM_SETUP.md)** (Google / email Auth + Firestore)
2. Sign in with Google, or create an email account, verify the email, and set your display name
3. Home: **Solo mode** (local only), **Create room** / **Join** with a 4-digit code, or tap a live room you already created or joined
4. **Create room** starts a new shared table (rake is on that form). Limit: 3 hosted rooms per account; rooms last 1 week then delete themselves. **Rooms** on the table detaches this device and returns to home; **Leave** keeps the code so you can rejoin; **End room** closes it for everyone
5. Others sign in, **Join** as viewers; the room host uses **People** to allow edit when needed. Share an in-progress Solo table from **Share** on the tracker

Product model: a **Room** is one live session (not a persistent Club). A Club layer can be added later on top of rooms.

## Installation as PWA

This app can be installed on your phone as a Progressive Web App (PWA):

### On iOS (Safari):
1. Visit the site on your iPhone/iPad
2. Tap the Share button
3. Select "Add to Home Screen"
4. The app will appear on your home screen like a native app

### On Android (Chrome):
1. Visit the site on your Android device
2. You may see an "Install" prompt, or
3. Use the menu (⋮) → "Add to Home Screen" or "Install app"
4. The app will be installed and work offline

## Deployment

This site is deployed on GitHub Pages at: https://ctt062.github.io/Poker-Stack-Tracker/

## License

MIT License

