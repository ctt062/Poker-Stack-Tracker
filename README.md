# Poker Stack Tracker

A minimalist web application for tracking chip stacks during poker games.

## Features

- **Blind Structure**: Set small and big blind amounts
- **Player Management**: Add players with their buy-in amounts
- **Stack Tracking**: Track total buy-ins with easy stack addition
- **Cash Out Tracking**: Record cash-out amounts for each player
- **P&L Calculation**: Automatic profit and loss calculation per player
- **Balance Overview**: View total cash balance across all players
- **Data Persistence**: Automatically saves game state to browser localStorage
- **Responsive Design**: Works on desktop and mobile devices
- **Progressive Web App (PWA)**: Installable as a native app on your phone
- **Offline Support**: Works offline with service worker caching
- **Dark/Light Mode**: Toggle between dark and light themes
- **Compact Mode**: Toggle between normal and compact font sizes

## How to Use

1. **Set Blind Structure**: Click "Set Blind Structure" to input small and big blind amounts
2. **Set Stack Amount**: Enter the default stack amount (e.g., $200)
3. **Add Players**: Click "Add Player" to add players with their names and buy-in amounts
4. **Track Buy-ins**: Use the '+' button to add additional stacks during the game
5. **Record Cash Out**: Enter the cash-out amount for each player
6. **View Statistics**: See real-time P&L and total balance
7. **Clear Stats**: Reset all data when starting a new game

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

## Local Development

Simply open `index.html` in a web browser to run locally.

## Technologies Used

- HTML5
- CSS3
- Vanilla JavaScript
- localStorage API for data persistence
- Progressive Web App (PWA) with Web App Manifest
- Service Worker for offline functionality and caching

## License

MIT License
