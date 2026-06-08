# FlashDrop Deployment Guide

## 🚀 Hosting FlashDrop Online

FlashDrop is a Python Flask application with P2P functionality. This guide shows you how to host it online so it can be accessed via Chrome browser.

## 🌐 Recommended Hosting Platforms

### Option 1: Railway (Easiest)
- Free tier available
- Automatic deployment from GitHub
- Supports Python Flask apps
- Built-in SSL certificates

### Option 2: Render
- Free tier available
- Simple deployment
- Good for Flask applications
- Automatic HTTPS

### Option 3: PythonAnywhere
- Free tier available
- Specialized for Python apps
- Easy setup
- Good for beginners

## 📋 Step-by-Step Deployment (Railway)

### 1. Prepare Your Code
```bash
cd /Users/pranavsharma/Documents/Projects/Ip
git init
git add .
git commit -m "Initial commit for FlashDrop deployment"
```

### 2. Create GitHub Repository
1. Go to GitHub.com
2. Create a new private repository
3. Push your code:
```bash
git remote add origin https://github.com/yourusername/flashdrop.git
git branch -M main
git push -u origin main
```

### 3. Deploy to Railway
1. Go to [railway.app](https://railway.app)
2. Sign up/login with GitHub
3. Click "New Project" → "Deploy from GitHub repo"
4. Select your flashdrop repository
5. Railway will automatically detect it's a Python app
6. Click "Deploy"

### 4. Configure Environment
Railway will automatically:
- Install dependencies from requirements.txt
- Start the Flask app using Procfile
- Assign a public URL
- Set up SSL certificates

### 5. Access Your App
- Railway will provide a URL like: `https://flashdrop-production.up.railway.app`
- Open this URL in Chrome to access your FlashDrop app

## 📋 Step-by-Step Deployment (Render)

### 1. Prepare Your Code
Same as Railway steps above

### 2. Create GitHub Repository
Same as Railway steps above

### 3. Deploy to Render
1. Go to [render.com](https://render.com)
2. Sign up/login with GitHub
3. Click "New" → "Web Service"
4. Connect your GitHub repository
5. Render will detect the render.yaml file
6. Click "Create Web Service"

### 4. Access Your App
- Render will provide a URL like: `https://flashdrop.onrender.com`
- Open this URL in Chrome to access your FlashDrop app

## 🔧 Important Notes

### P2P Limitations
- FlashDrop uses P2P TCP connections
- On cloud hosting, P2P may have limitations
- Both devices need internet connectivity
- Firewall settings may affect connections

### Data Storage
- Cloud hosting has temporary storage
- Files are stored in temporary directories
- Auto-delete after transfer is recommended
- Consider using cloud storage for persistence

### Performance
- Free tiers may have resource limits
- Large file transfers may timeout
- Consider upgrading for production use

## 🌍 Accessing Your Deployed App

### From Any Device
1. Get your deployed URL (e.g., `https://flashdrop.onrender.com`)
2. Open in Chrome browser
3. The app will work the same as local version
4. Share the URL with others to test

### Network Considerations
- Both devices need internet access
- P2P connections work over internet
- May need to configure firewall settings
- Some networks may block P2P connections

## 🎯 Next Steps

1. **Deploy**: Follow the steps above for Railway or Render
2. **Test**: Access your deployed URL in Chrome
3. **Share**: Share the URL with others for testing
4. **Monitor**: Check logs for any issues
5. **Upgrade**: Consider paid plans for better performance

## 📞 Support

If you encounter issues:
- Check platform logs for errors
- Verify all files are committed to Git
- Ensure requirements.txt has all dependencies
- Check firewall and network settings
- Review platform documentation

## ✅ Deployment Checklist

- [ ] Code committed to GitHub
- [ ] requirements.txt updated with all dependencies
- [ ] Procfile created for deployment
- [ ] render.yaml created (for Render)
- [ ] Repository pushed to GitHub
- [ ] Connected to hosting platform
- [ ] Deployment successful
- [ ] App accessible via URL
- [ ] Tested file sharing functionality
- [ ] Monitored for errors
