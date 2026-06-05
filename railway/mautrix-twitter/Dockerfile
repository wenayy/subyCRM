FROM dock.mau.dev/mautrix/twitter:latest
USER root
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
VOLUME /data
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
