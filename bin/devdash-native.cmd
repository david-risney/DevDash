@echo off
setlocal DisableDelayedExpansion
node "%~dp0devdash-native.js" %*
exit /b %errorlevel%
