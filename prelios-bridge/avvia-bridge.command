#!/bin/sh
# OptiRoute Bridge - avvio con un doppio clic su macOS
cd "$(dirname "$0")" || exit 1
if ! python3 -c "import sys" >/dev/null 2>&1; then
  echo "Python 3 non e' installato su questo Mac."
  echo "Installalo da https://www.python.org/downloads/ e poi riprova."
  printf "Premi Invio per chiudere."; read -r _
  exit 1
fi
python3 avvia_bridge.py "$@"
stato=$?
if [ "$stato" -ne 0 ]; then
  printf "Premi Invio per chiudere."; read -r _
fi
exit "$stato"
