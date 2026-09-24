@echo off
rem Make the pre-recorded openers and commercials.
rem
rem Run this once with LM Studio open. It writes and records the announcer's
rem open, a sixty-second commercial and the show's break commercials, and puts
rem the audio on the shelf. After that, pressing Start plays files instead of
rem waiting on the model, which is most of the difference between a show that
rem starts in half a second and one that starts in seven minutes.
rem
rem Anchored to this file's own folder, so it works from a desktop shortcut,
rem from another drive, or from wherever a shortcut's "Start in" happens to
rem point. Running `npm run openers` from C:\Users\YourName is how this went
rem wrong the first time - npm reads package.json from the CURRENT directory,
rem not from where the project lives.
cd /d "%~dp0"

echo.
echo   Making opening packs
echo   --------------------
echo.

rem Is a model actually up? Failing here with a clear sentence beats failing
rem three minutes in with a fetch error nobody can read.
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

echo   LM Studio is up. This takes a while - each pack is an opener, a
echo   sixty-second commercial and the show's break commercials, and every
echo   one of them is written and then recorded.
echo.

rem Three packs. Each fronts three shows before the next comes up, so this is
rem roughly nine shows' worth of openings.
call npm run openers -- 3

echo.
echo   Done. Run this again whenever you want fresh ones.
echo.
pause
