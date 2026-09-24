@echo off
rem Fill the commercial bucket.
rem
rem Writes and records five new commercials and drops them in the bucket. Both
rem shows take their ad breaks from there, so every one of these is a break
rem that never has to be written live again - and nothing in the bucket is ever
rem deleted to make room for them.
rem
rem Anchored to this file's own folder. npm reads package.json from the CURRENT
rem directory, so running this from anywhere else looks for a project that is
rem not there.
cd /d "%~dp0"

echo.
echo   Filling the commercial bucket
echo   ----------------------------
echo.

rem Fail with a sentence rather than a stack trace three minutes in.
curl -s -m 5 -o nul http://127.0.0.1:1234/v1/models
if errorlevel 1 (
    echo   LM Studio is not answering on port 1234.
    echo.
    echo   Open LM Studio, load your model, and make sure the local server
    echo   is started. Then run this again.
    echo.
    pause
    exit /b 1
)

rem Five is the batch size that was asked for. Pass a number to change it:
rem   Make-Commercials.bat 12
set COUNT=%1
if "%COUNT%"=="" set COUNT=5

echo   LM Studio is up. Writing and recording %COUNT% commercials.
echo   Each one is written, then read, then mixed over a bed.
echo.

call npm run commercials -- %COUNT%

echo.
echo   They are in the bucket now. Open the Commercials tab to hear them.
echo.
pause
