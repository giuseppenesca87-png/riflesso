# Il punto d'incontro di Riflesso, per stare su una macchina nostra.
#
# Su Deno Deploy le due parti potevano finire su isolati diversi, e senza
# memoria condivisa (KV) non si trovavano finché il telefono non riprovava:
# 3 secondi contro 28. Qui il processo e' uno solo, quindi la memoria in
# process basta e avanza — il difetto sparisce per costruzione.
FROM denoland/deno:alpine-2.1.9

WORKDIR /app

# Prima il codice, poi la webapp: cosi' cambiare una icona non ricompila tutto.
COPY main.ts deno.jsonc ./
COPY public ./public

# La cache dei moduli si scalda in fase di build, non alla prima richiesta.
RUN deno cache main.ts

ENV PORT=8080
ENV BIND=0.0.0.0
EXPOSE 8080

USER deno

# --allow-net=0.0.0.0:8080 vuol dire **ascoltare e basta**: il ponte non fa
# nessuna chiamata in uscita (verificato: zero fetch in main.ts), quindi non
# gli serve poter raggiungere niente — e in particolare non deve poter
# raggiungere gli altri container sulla stessa rete, cosa
# che con --allow-net nudo poteva fare (provato il 01/09/2026).
# --allow-read per servire ./public, --allow-env per PORT e BIND. Niente
# scrittura su disco: non tiene niente.
CMD ["run", "--allow-net=0.0.0.0:8080", "--allow-read=/app", "--allow-env", "main.ts"]
