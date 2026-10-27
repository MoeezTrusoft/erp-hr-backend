FROM library/nextcloud:35.0.2-apache@sha256:05d97ac87266d2914fadd17280a6a1aab42d164ae5554ef843a349c2c5564a85
ARG LIBRESIGN_VERSION=15.0.8
ARG LIBRESIGN_SHA256=4b43d7b161d65464f1df93a38eb9d18bd901e51773a02b74081cca9d802a8543
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils fontconfig ca-certificates && rm -rf /var/lib/apt/lists/*
RUN --mount=type=bind,source=.,target=/build,readonly \
    if [ -s "/build/vendor/libresign-v${LIBRESIGN_VERSION}.tar.gz" ]; then \
      cp "/build/vendor/libresign-v${LIBRESIGN_VERSION}.tar.gz" /tmp/libresign.tar.gz; \
    else \
      curl -fsSL --connect-timeout 15 --max-time 180 --retry 3 "https://github.com/LibreSign/libresign/releases/download/v${LIBRESIGN_VERSION}/libresign-v${LIBRESIGN_VERSION}.tar.gz" -o /tmp/libresign.tar.gz; \
    fi \
 && echo "${LIBRESIGN_SHA256}  /tmp/libresign.tar.gz" | sha256sum -c - \
 && mkdir -p /usr/src/nextcloud/custom_apps \
 && tar -xzf /tmp/libresign.tar.gz -C /usr/src/nextcloud/custom_apps \
 && test -f /usr/src/nextcloud/custom_apps/libresign/appinfo/info.xml \
 && chown -R www-data:www-data /usr/src/nextcloud/custom_apps/libresign \
 && rm /tmp/libresign.tar.gz
COPY --chmod=755 bootstrap.sh /opt/recruitment/bootstrap.sh
