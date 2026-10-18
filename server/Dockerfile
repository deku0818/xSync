# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM node:22.22.1-alpine AS admin
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY server/admin/ server/admin/
COPY shared/i18n.ts shared/i18n.ts
COPY server/scripts/build-admin.mjs server/scripts/build-admin.mjs
RUN npm run build:admin

FROM --platform=$BUILDPLATFORM golang:1.27.0-alpine AS build
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download && go mod verify
COPY server/cmd/ ./cmd/
COPY server/internal/ ./internal/
COPY --from=admin /src/server/internal/syncstore/admin/app.js ./internal/syncstore/admin/app.js
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags='-s -w' -o /out/xsync-server ./cmd/obsidiansync
RUN mkdir -p /runtime/objects && chown -R 65532:65532 /runtime

FROM scratch
COPY LICENSE /usr/share/licenses/xsync/LICENSE
COPY --from=admin /src/node_modules/dompurify/LICENSE /usr/share/licenses/dompurify/LICENSE
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/xsync-server /usr/local/bin/xsync-server
COPY --from=build --chown=65532:65532 /runtime/ /data/
USER 65532:65532
WORKDIR /data
EXPOSE 8873
ENTRYPOINT ["/usr/local/bin/xsync-server"]
CMD []
