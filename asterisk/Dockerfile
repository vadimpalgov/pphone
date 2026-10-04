FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive TZ=Europe/Moscow

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential wget ca-certificates iproute2 \
        libssl-dev libncurses5-dev uuid-dev libjansson-dev \
        libxml2-dev libsqlite3-dev libedit-dev libsrtp2-dev \
        libopus-dev pkg-config openssl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src
RUN wget -q https://downloads.asterisk.org/pub/telephony/asterisk/asterisk-20-current.tar.gz && \
    tar xzf asterisk-20-current.tar.gz && \
    rm asterisk-20-current.tar.gz && \
    mv asterisk-20* asterisk-src

WORKDIR /usr/src/asterisk-src
RUN ./configure --with-jansson-bundled && \
    make -j"$(nproc)" && \
    make install && \
    make samples && \
    make config && \
    make install-logrotate && \
    ldconfig

WORKDIR /
RUN rm -rf /usr/src/asterisk-src

COPY conf/ /etc/asterisk/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8088/tcp
EXPOSE 5060/udp
EXPOSE 10000-10200/udp

ENTRYPOINT ["/entrypoint.sh"]
