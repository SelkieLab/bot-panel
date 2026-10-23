# bot-panel 容器镜像
# 只装 Python 与 docker CLI：面板本身零第三方依赖，但要用 docker 命令管容器。
FROM python:3.12-alpine

# docker CLI 用于控制上游容器；tzdata 让容器内时间与宿主一致
RUN apk add --no-cache docker-cli tzdata openssl \
    && addgroup -g 1001 -S botpanel \
    && adduser -u 1001 -S botpanel -G botpanel -h /app

WORKDIR /app

COPY server.py qqrefresh.py ./
COPY static ./static
COPY personas.example.json ./

# 运行时目录，挂卷覆盖
RUN mkdir -p /app/cache /app/downloads /app/knowledge /app/tls \
    && chown -R botpanel:botpanel /app

ENV PYTHONUNBUFFERED=1 \
    PANEL_PORT=16666 \
    TZ=Asia/Shanghai

USER botpanel

EXPOSE 16666

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:16666/healthz', timeout=4).status==200 else 1)"

CMD ["python", "server.py"]
