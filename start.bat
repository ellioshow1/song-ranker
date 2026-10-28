@echo off
rem Serves Song Ranker at http://127.0.0.1:8775/ (use this exact address as a Spotify redirect URI when testing the export locally).
cd /d "%~dp0"
start "" http://127.0.0.1:8775/
python -m http.server 8775 --bind 127.0.0.1
