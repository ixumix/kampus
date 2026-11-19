# Кампус — образ для хостинга. Внешних зависимостей нет: только стандартная библиотека Python.
FROM python:3.12-slim
WORKDIR /app
COPY server ./server
COPY web ./web
# База — в отдельном каталоге (подключите том /data, чтобы заявки и отметки пережили перезапуск).
ENV CAMPUS_HOST=0.0.0.0 \
    PORT=8080 \
    CAMPUS_DB=/data/campus.db \
    CAMPUS_TRUST_PROXY=1 \
    PYTHONUNBUFFERED=1
# Хостинг монтирует постоянное хранилище в /data поверх образа, с правами root, поэтому процесс работает от root.
RUN mkdir -p /data
EXPOSE 8080
# Ключ модели (необязательно) — только переменной окружения DEEPSEEK_API_KEY в настройках хостинга, не в образе.
CMD ["python", "-m", "server"]
