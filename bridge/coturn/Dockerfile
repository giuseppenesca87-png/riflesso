# Il rimbalzo, senza nemmeno una capacità.
#
# L'immagine ufficiale di coturn porta `cap_net_bind_service` **sul file**
# `/usr/bin/turnserver`, perché di suo sa ascoltare anche sulle porte basse.
# A noi non serve: ascoltiamo sulla 3478 e sull'intervallo 49200-49400, tutte
# ben sopra la 1024.
#
# Quella capacità però litiga con `cap_drop: ALL`: se il file dichiara una
# capacità che non è nell'insieme del container, il kernel **rifiuta di
# eseguirlo** — `exec /usr/bin/turnserver: operation not permitted`, e il
# container riparte all'infinito. Provato sulla VPS il 05/09/2026: con
# `cap_drop: ALL` non parte né da root né da utente normale; senza, parte.
#
# Le due uscite erano: riaggiungere `NET_BIND_SERVICE` al container, oppure
# togliere la capacità dal file. Si toglie dal file: così il processo gira
# davvero con **zero** capacità, invece di averne una che non usa.
FROM coturn/coturn:4.17.2-alpine
USER root
RUN apk add --no-cache libcap \
 && setcap -r /usr/bin/turnserver \
 && apk del libcap
USER 65534
