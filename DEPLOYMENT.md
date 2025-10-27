# Deployment Guide for GitHub Pages

## Steps to Enable GitHub Pages

1. **Go to your GitHub repository**
   - Visit: https://github.com/ctt062/Poker-Stack-Tracker

2. **Navigate to Settings**
   - Click on the "Settings" tab at the top of your repository

3. **Go to Pages section**
   - In the left sidebar, click on "Pages"

4. **Configure Source**
   - Under "Source", select "Deploy from a branch"
   - Under "Branch", select "main" and "/ (root)"
   - Click "Save"

5. **Wait for Deployment**
   - GitHub will automatically build and deploy your site
   - This usually takes 1-2 minutes

6. **Access Your Site**
   - Once deployed, your site will be available at:
   - **https://ctt062.github.io/Poker-Stack-Tracker/**

## Updating the Site

Whenever you make changes and push to the main branch, GitHub Pages will automatically rebuild and deploy your site:

```bash
git add .
git commit -m "Your commit message"
git push origin main
```

## Notes

- The site is static HTML/CSS/JavaScript, so it deploys instantly
- All data is stored in the browser's localStorage
- No backend server is required
