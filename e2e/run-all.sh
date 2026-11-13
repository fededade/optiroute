#!/usr/bin/env bash
# Prove end-to-end di OptiRoute nel browser (Playwright), sulla nuova interfaccia.
# Tutti i servizi esterni sono simulati: mappe, geocodifica, Retell, bridge.
# Nessuna richiesta esce verso servizi veri e non parte nessuna telefonata.
#
# Uso:   bash e2e/run-all.sh [cartella-del-repo]     (default: il repo che contiene questa cartella)
#        npm run test:e2e
# Serve Playwright con Chromium (`require('playwright')` deve funzionare: nelle
# sessioni cloud di Claude Code c'è già; in locale `npm i -D playwright` e
# `npx playwright install chromium`).
#
# Porte (variabili d'ambiente, tutte facoltative):
#   VITE_PORT    server Vite dell'app           (default 5271)
#   VITE_PORT_2  secondo server Vite            (default 5272; oggi nessuna prova lo usa)
#   CLOUD_PORT   server cloud di sviluppo       (default 8791; solo per cloud-real.js)
#   GESTIONALE_CLOUD_PORT   server cloud con il gestionale finto (default 8792; solo gestionale.js)
#   GESTIONALE_PARENT_PORT  pagina del gestionale finto (default 5281; +1 per la pagina NON autorizzata)
# Prove da lanciare: ONLY="autopilot tabs" bash e2e/run-all.sh   (default: tutte)
#
# Le sei serie:
#   autopilot     pilota automatico: approvazione, chiamate, esiti, alternative, rimpiazzi, bridge
#   cloud-client  client del cloud: attivazione, modifiche locali, esiti dal server, errori
#   cloud-real    a browser chiuso, sui bundle veri delle funzioni (archivio in memoria, Retell finto)
#   tabs          due schede dello stesso browser: una sola fa da pilota
#   finestre      giro di tutte le finestre a 1440 e a 390 px, con schermate
#   gestionale    OptiRoute dentro la pagina del gestionale (iframe, accesso, bridge, conferme)
#
# Avvia SOLO i server che servono, ognuno nel suo gruppo di processi, e alla
# fine spegne solo quelli (per PID/gruppo, mai pkill con schemi). Se una porta è
# già occupata si ferma: non prova mai contro il server di qualcun altro.
# Log:        e2e/logs/<nome>.log  (+ vite.log, cloud-server.log)
# Schermate:  e2e/shots/ (finestre) e e2e/shots-<nome>/ (le altre prove)
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${1:-$HERE/..}"
if [ ! -f "$REPO/package.json" ] || [ ! -f "$REPO/scripts/dev-cloud-server.mjs" ]; then
  echo "Uso: bash $0 [cartella-del-repo optiroute]" >&2
  exit 2
fi
REPO="$(cd "$REPO" && pwd)"
VITE_PORT="${VITE_PORT:-5271}"
VITE_PORT_2="${VITE_PORT_2:-5272}"
CLOUD_PORT="${CLOUD_PORT:-8791}"
CLOUD_KEY="chiave-e2e-0123456789abcdefghij"
GESTIONALE_CLOUD_PORT="${GESTIONALE_CLOUD_PORT:-8792}"
GESTIONALE_PARENT_PORT="${GESTIONALE_PARENT_PORT:-5281}"
GESTIONALE_KEY="chiave-e2e-gestionale-0123456789"
ONLY="${ONLY:-autopilot cloud-client cloud-real tabs finestre gestionale}"
LOGS="$HERE/logs"
mkdir -p "$LOGS" "$HERE/shots"

STARTED_PIDS=()

cleanup() {
  for pid in "${STARTED_PIDS[@]:-}"; do
    [ -z "$pid" ] && continue
    # ogni server è capo del suo gruppo (setsid): si spegne il gruppo che abbiamo creato noi
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  done
  for pid in "${STARTED_PIDS[@]:-}"; do
    [ -z "$pid" ] && continue
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -KILL -- "-$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT
trap 'exit 130' INT TERM

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

wait_http() { # url, secondi
  for _ in $(seq 1 $(( $2 * 4 ))); do
    curl -s -o /dev/null --max-time 2 "$1" && return 0
    sleep 0.25
  done
  return 1
}

for p in "$VITE_PORT" "$CLOUD_PORT" "$GESTIONALE_CLOUD_PORT" "$GESTIONALE_PARENT_PORT" "$(( GESTIONALE_PARENT_PORT + 1 ))"; do
  if port_busy "$p"; then
    echo "La porta $p è già occupata: scegli altre porte (VITE_PORT / CLOUD_PORT / GESTIONALE_CLOUD_PORT / GESTIONALE_PARENT_PORT) nelle fasce 5271-5289 / 8791-8799." >&2
    exit 3
  fi
done

if [ ! -d "$REPO/node_modules/vite" ]; then
  echo "node_modules assente in $REPO: eseguo npm ci" >&2
  (cd "$REPO" && npm ci) > "$LOGS/npm-ci.log" 2>&1 || { echo "npm ci fallito (vedi $LOGS/npm-ci.log)" >&2; exit 4; }
fi

echo "Repo: $REPO ($(cd "$REPO" && git log --oneline -1 2>/dev/null))"
echo "Avvio Vite su 127.0.0.1:$VITE_PORT"
(cd "$REPO" && exec setsid npx vite --port "$VITE_PORT" --strictPort --host 127.0.0.1) > "$LOGS/vite.log" 2>&1 &
STARTED_PIDS+=("$!")
if ! wait_http "http://127.0.0.1:$VITE_PORT/" 60; then
  echo "Vite non risponde (vedi $LOGS/vite.log)" >&2
  exit 5
fi

start_cloud() {
  echo "Avvio il server cloud di sviluppo su 127.0.0.1:$CLOUD_PORT (archivio in memoria, Retell finto)"
  (cd "$REPO" && unset VERCEL_ENV RETELL_API_KEY && PORT="$CLOUD_PORT" CRON_SECRET="$CLOUD_KEY" FAKE_RETELL=1 \
    exec setsid node scripts/dev-cloud-server.mjs) > "$LOGS/cloud-server.log" 2>&1 &
  STARTED_PIDS+=("$!")
  wait_http "http://127.0.0.1:$CLOUD_PORT/api/cloud?op=ping" 30
}

start_gestionale_cloud() {
  echo "Avvio il server cloud di sviluppo con il gestionale FINTO su 127.0.0.1:$GESTIONALE_CLOUD_PORT (pagina del gestionale: 127.0.0.1:$GESTIONALE_PARENT_PORT)"
  (cd "$REPO" && unset VERCEL_ENV RETELL_API_KEY GESTIONALE_ORIGINS GESTIONALE_FIREBASE_PROJECTS && PORT="$GESTIONALE_CLOUD_PORT" CRON_SECRET="$GESTIONALE_KEY" FAKE_RETELL=1 \
    exec setsid node scripts/dev-cloud-server.mjs --gestionale-test --gestionale-origin "http://127.0.0.1:$GESTIONALE_PARENT_PORT") > "$LOGS/gestionale-cloud-server.log" 2>&1 &
  STARTED_PIDS+=("$!")
  wait_http "http://127.0.0.1:$GESTIONALE_CLOUD_PORT/api/cloud?op=ping" 30
}

declare -A ESITO PASS FAIL CODE DUR
ORDER=()
run_one() { # nome file [args...]
  local name="$1" file="$2"; shift 2
  ORDER+=("$name")
  echo "--- $name"
  local t0=$SECONDS
  (cd "$HERE" && VITE_PORT="$VITE_PORT" VITE_PORT_2="$VITE_PORT_2" CLOUD_PORT="$CLOUD_PORT" \
     GESTIONALE_CLOUD_PORT="$GESTIONALE_CLOUD_PORT" GESTIONALE_PARENT_PORT="$GESTIONALE_PARENT_PORT" \
     timeout 900 node "$file" "$@") > "$LOGS/$name.log" 2>&1
  local rc=$?
  DUR[$name]=$(( SECONDS - t0 ))
  CODE[$name]=$rc
  local line
  line="$(grep -E '^RISULTATO passati=[0-9]+ falliti=[0-9]+' "$LOGS/$name.log" | tail -1)"
  if [ -n "$line" ]; then
    PASS[$name]="$(sed -E 's/.*passati=([0-9]+).*/\1/' <<<"$line")"
    FAIL[$name]="$(sed -E 's/.*falliti=([0-9]+).*/\1/' <<<"$line")"
  else
    PASS[$name]="?"; FAIL[$name]="?"
  fi
  if [ "$rc" -eq 0 ] && [ "${FAIL[$name]}" = "0" ]; then ESITO[$name]="OK"; else ESITO[$name]="FALLITO"; fi
  echo "    ${ESITO[$name]} (codice $rc, ${DUR[$name]}s) - log: $LOGS/$name.log"
}

for t in $ONLY; do
  case "$t" in
    autopilot)    run_one autopilot autopilot.js ;;
    cloud-client) run_one cloud-client cloud-client.js ;;
    cloud-real)
      if start_cloud; then run_one cloud-real cloud-real.js
      else ORDER+=(cloud-real); ESITO[cloud-real]="FALLITO"; PASS[cloud-real]=0; FAIL[cloud-real]=1; CODE[cloud-real]=99; DUR[cloud-real]=0
        echo "server cloud non partito (vedi $LOGS/cloud-server.log)" >&2; fi ;;
    tabs)         run_one tabs tabs.js ;;
    finestre)     run_one finestre finestre.js all ;;
    gestionale)
      if start_gestionale_cloud; then run_one gestionale gestionale.js
      else ORDER+=(gestionale); ESITO[gestionale]="FALLITO"; PASS[gestionale]=0; FAIL[gestionale]=1; CODE[gestionale]=99; DUR[gestionale]=0
        echo "server cloud (gestionale) non partito (vedi $LOGS/gestionale-cloud-server.log)" >&2; fi ;;
    *) echo "prova sconosciuta: $t" >&2 ;;
  esac
done

echo
printf '%-14s %-9s %8s %8s %7s %6s\n' "script" "esito" "passati" "falliti" "codice" "sec"
printf '%-14s %-9s %8s %8s %7s %6s\n' "--------------" "---------" "--------" "--------" "-------" "------"
FAILED=0
for n in "${ORDER[@]}"; do
  printf '%-14s %-9s %8s %8s %7s %6s\n' "$n" "${ESITO[$n]}" "${PASS[$n]}" "${FAIL[$n]}" "${CODE[$n]}" "${DUR[$n]}"
  [ "${ESITO[$n]}" = "OK" ] || FAILED=1
done
echo
echo "Schermate: $HERE/shots/ (finestre) e $HERE/shots-*/"
exit $FAILED
