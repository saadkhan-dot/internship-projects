@echo off
setlocal
set "PHP=C:\xampp\php\php.exe"
set "URL=http://127.0.0.1:8000/"

if not exist "%PHP%" (
  echo PHP was not found at %PHP%.
  echo Install XAMPP or edit this launcher with your php.exe path.
  pause
  exit /b 1
)

netstat -ano | findstr /R /C:":8000 .*LISTENING" >nul
if errorlevel 1 (
  start "Lorem Check PHP server" "%PHP%" -S 127.0.0.1:8000 -t "%~dp0"
  timeout /t 2 /nobreak >nul
)

start "" "%URL%"
endlocal
