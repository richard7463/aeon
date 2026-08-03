FROM node:22-alpine

WORKDIR /opt/ai2human-handoff

# Scripts only — the rest of the AEON repo is not needed at runtime.
COPY scripts scripts
COPY deploy/ai2human-handoff/entrypoint.sh /entrypoint.sh

RUN mkdir -p .ai2human-state logs memory/logs \
    && chmod +x /entrypoint.sh

# State and logs live on a mounted volume so they survive container restarts.
VOLUME ["/opt/ai2human-handoff/.ai2human-state", "/opt/ai2human-handoff/logs"]

CMD ["/entrypoint.sh"]
