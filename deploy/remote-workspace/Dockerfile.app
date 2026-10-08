FROM oven/bun:1.3.5 AS build
WORKDIR /opt/kanna-build-source
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.3.5 AS production-dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

FROM oven/bun:1.3.5 AS runtime
ARG REMOTE_UID=1000
ARG REMOTE_GID=1000
ENV BUN_INSTALL=/opt/bun \
    BUN_INSTALL_BIN=/opt/bun/bin \
    CODEX_HOME=/home/kanna/.codex \
    HOME=/home/kanna \
    KANNA_RUNTIME_PROFILE=prod \
    PATH=/opt/bun/bin:/usr/local/bun-node-fallback-bin:/usr/local/sbin:/usr/sbin:/sbin:/usr/local/bin:/usr/bin:/bin
RUN if [ "${REMOTE_UID}" -le 0 ] || [ "${REMOTE_GID}" -le 0 ]; then echo "REMOTE_UID and REMOTE_GID must be positive" >&2; exit 1; fi \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git ca-certificates nodejs passwd \
    && rm -rf /var/lib/apt/lists/* \
    && command -v git node bun getent groupadd useradd usermod \
    && if ! getent group "${REMOTE_GID}" >/dev/null; then \
      if getent group kanna >/dev/null; then groupadd --gid "${REMOTE_GID}" "kanna-${REMOTE_GID}"; else groupadd --gid "${REMOTE_GID}" kanna; fi; \
    fi \
    && if getent passwd "${REMOTE_UID}" >/dev/null; then \
      existing_user="$(getent passwd "${REMOTE_UID}" | cut -d: -f1)"; \
      if [ "${existing_user}" != kanna ]; then \
        if getent passwd kanna >/dev/null; then echo "Kanna account name already exists with a different UID" >&2; exit 1; fi; \
        usermod --login kanna --home /home/kanna --move-home --shell /bin/bash "${existing_user}"; \
      else usermod --home /home/kanna --shell /bin/bash kanna; fi; \
    else useradd --uid "${REMOTE_UID}" --gid "${REMOTE_GID}" --create-home --home-dir /home/kanna --shell /bin/bash kanna; fi \
    && mkdir -p /home/kanna /opt/bun
ENV PATH=/app/bin:/opt/bun/bin:/usr/local/sbin:/usr/sbin:/sbin:/usr/local/bin:/usr/bin:/bin:/usr/local/bun-node-fallback-bin
WORKDIR /app
COPY --from=build --chown=${REMOTE_UID}:${REMOTE_GID} /opt/kanna-build-source/bin ./bin
COPY --from=build --chown=${REMOTE_UID}:${REMOTE_GID} /opt/kanna-build-source/dist ./dist
COPY --from=build --chown=${REMOTE_UID}:${REMOTE_GID} /opt/kanna-build-source/package.json ./package.json
COPY --from=production-dependencies --chown=${REMOTE_UID}:${REMOTE_GID} /app/node_modules ./node_modules
RUN bun add --global @openai/codex@0.161.0 \
    && chown -R "${REMOTE_UID}:${REMOTE_GID}" /opt/bun \
    && command -v kanna \
    && test "$(command -v kanna)" = /app/bin/kanna \
    && command -v codex \
    && test "$(command -v node)" = /usr/bin/node \
    && node --version \
    && codex --version
USER ${REMOTE_UID}:${REMOTE_GID}
EXPOSE 3210
ENTRYPOINT ["bun", "./bin/kanna"]
