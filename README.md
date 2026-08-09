# Poker Stack Tracker

![Poker Stack Tracker Dark Mode](Poker_Stack_Tracker_Dark.png)

A minimalist web application for tracking chip stacks during poker games.

## Features

- **Blind Structure**: Set small and big blind amounts
- **Player Management**: Add players with their buy-in amounts
- **Stack Tracking**: Track total buy-ins with easy stack addition
- **Cash Out Tracking**: Record cash-out amounts for each player
- **P&L Calculation**: Automatic profit and loss calculation per player
- **Balance Overview**: View total cash balance across all players
- **Data Persistence**: Automatically saves game state to browser localStorage
- **Rooms (multi-device sync)**: Create a short room code so other phones join the same live session; host edits by default and can grant edit access
- **Responsive Design**: Works on desktop and mobile devices
- **Progressive Web App (PWA)**: Installable as a native app on your phone
- **Offline Support**: Works offline with service worker caching (solo mode)
- **Dark/Light Mode**: Toggle between dark and light themes
- **Compact Mode**: Toggle between normal and compact font sizes

## Rooms (optional)

Solo play needs no account or server. For multi-device sync:

1. Follow **[ROOM_SETUP.md](ROOM_SETUP.md)** (Firebase Anonymous Auth + Firestore)
2. Fill in `firebase-config.js` and publish `firestore.rules`
3. **Room → Create room** on the host phone, share the code
4. Others **Join** as viewers; host uses **People** to allow edit when needed

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

