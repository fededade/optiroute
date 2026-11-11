"""Browser Selenium autonomo per il bridge Prelios.

Indipendente dal progetto MISI: apre/si collega a un Chrome con remote
debugging su una porta e un profilo DEDICATI (diversi da quelli di MISI),
così i due possono anche coesistere senza pestarsi i piedi.

Logica ripresa da browser_session.py di MISI, ridotta al minimo necessario
per il recupero telefoni (login, navigazione, lettura campi).

Chrome viene cercato nei percorsi tipici di Windows, macOS e Linux; la
variabile d'ambiente CHROME_PATH permette di indicarne uno diverso.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import time
from typing import Any

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.common.exceptions import (
    JavascriptException,
    StaleElementReferenceException,
    WebDriverException,
)

# Chrome su Windows (con fallback al PATH)
CHROME_PATHS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
]

# Chrome su macOS
CHROME_PATHS_MAC = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    os.path.expanduser("~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
]

# Chrome/Chromium su Linux: nomi cercati nel PATH, poi percorsi tipici
CHROME_NAMES_LINUX = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
CHROME_PATHS_LINUX = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
]

# Porta e profilo DEDICATI al bridge (MISI usa 9222 / chrome_prelios_debug):
# così il bridge è indipendente e può girare anche con MISI aperto.
DEBUG_PORT = 9223
PROFILE_DIR = os.path.join(
    os.environ.get("TEMP", os.path.expanduser("~")), "chrome_prelios_bridge"
)


def _find_chrome() -> str:
    """Percorso di Chrome. Ordine: variabile d'ambiente CHROME_PATH (override
    esplicito), poi i percorsi del sistema operativo corrente. Su Windows il
    comportamento è quello di sempre (percorsi standard, poi 'chrome.exe')."""
    override = os.environ.get("CHROME_PATH", "").strip().strip('"')
    if override:
        if not os.path.exists(override):
            print(f"ATTENZIONE: CHROME_PATH={override} non esiste; provo comunque.")
        return override

    if sys.platform.startswith("win"):
        for path in CHROME_PATHS:
            if os.path.exists(path):
                return path
        return "chrome.exe"

    if sys.platform == "darwin":
        for path in CHROME_PATHS_MAC:
            if os.path.exists(path):
                return path
        return CHROME_PATHS_MAC[0]

    for name in CHROME_NAMES_LINUX:
        found = shutil.which(name)
        if found:
            return found
    for path in CHROME_PATHS_LINUX:
        if os.path.exists(path):
            return path
    return "google-chrome"


class PreliosBrowser:
    """Wrapper Selenium minimale per Prelios VT-Desktop."""

    def __init__(self, page_load_timeout: int = 30, element_wait_timeout: int = 15):
        self.page_load_timeout = page_load_timeout
        self.element_wait_timeout = element_wait_timeout
        self.driver: webdriver.Chrome | None = None
        self._proc = None

    def start(self) -> None:
        """Avvia Chrome normale con remote debugging e vi collega Selenium.

        NON in modalità automazione: il portale Prelios si comporta come col
        browser manuale, e tu puoi fare il login MFA a mano nella finestra.
        """
        chrome = _find_chrome()
        os.makedirs(PROFILE_DIR, exist_ok=True)
        args = [
            chrome,
            f"--remote-debugging-port={DEBUG_PORT}",
            f"--user-data-dir={PROFILE_DIR}",
            "--start-maximized",
            "--disable-popup-blocking",
            "--no-first-run",
            "--no-default-browser-check",
        ]

        running = False
        try:
            with socket.create_connection(("127.0.0.1", DEBUG_PORT), timeout=1):
                running = True
        except OSError:
            pass

        if not running:
            self._proc = subprocess.Popen(
                args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
            time.sleep(3)
        else:
            time.sleep(1)

        options = Options()
        options.debugger_address = f"127.0.0.1:{DEBUG_PORT}"
        self.driver = webdriver.Chrome(options=options)
        self.driver.set_page_load_timeout(self.page_load_timeout)

    def stop(self) -> None:
        if self.driver:
            try:
                self.driver.quit()
            except WebDriverException:
                pass
            self.driver = None
        if self._proc:
            try:
                self._proc.terminate()
                self._proc.wait(timeout=5)
            except Exception:
                try:
                    self._proc.kill()
                except Exception:
                    pass
            self._proc = None

    @property
    def is_running(self) -> bool:
        if not self.driver:
            return False
        try:
            _ = self.driver.title
            return True
        except WebDriverException:
            return False

    # --- Navigazione ---

    def navigate(self, url: str) -> None:
        self.driver.get(url)

    @property
    def current_url(self) -> str:
        return self.driver.current_url if self.driver else ""

    @property
    def title(self) -> str:
        return self.driver.title if self.driver else ""

    def wait(self, seconds: float) -> None:
        time.sleep(seconds)

    # --- Esecuzione JS con retry sugli errori transitori ---

    def execute_js(self, script: str, *args) -> Any:
        last_error = None
        for attempt in range(3):
            try:
                return self.driver.execute_script(script, *args)
            except (JavascriptException, StaleElementReferenceException) as e:
                last_error = e
                time.sleep(1)
            except Exception as e:
                if "alert" in str(type(e).__name__).lower() or "alert" in str(e).lower():
                    self.dismiss_alert()
                    time.sleep(1)
                    continue
                raise
        if last_error:
            raise last_error
        return None

    def dismiss_alert(self) -> str | None:
        try:
            alert = self.driver.switch_to.alert
            text = alert.text
            alert.accept()
            return text
        except Exception:
            return None

    # --- Frame ---

    def switch_to_default(self) -> None:
        self.driver.switch_to.default_content()

    def switch_to_frame(self, frame) -> None:
        self.driver.switch_to.frame(frame)

    def get_frame_count(self) -> int:
        return self.execute_js(
            "return document.querySelectorAll('iframe, frame').length;"
        ) or 0
