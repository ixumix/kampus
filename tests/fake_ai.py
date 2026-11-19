"""Подставная модель для тестов: детерминированный ответ без сети и без ключа."""


class FakeModel:
    def __init__(self, key=True, reply=None):
        self.has_key = key
        self.reply = reply
        self.calls = 0
        self.last_user = None

    def available(self):
        return self.has_key

    def complete(self, system, user):
        self.calls += 1
        self.last_user = user
        text = self.reply if self.reply is not None else (
            "В понедельник Международное публичное право переехало из ауд. 412 в ауд. 318, корпус Б, "
            "в среду его перенесли на 12:40, а немецкий в четверг отменили — изменения стоит подтвердить. "
            "До среды сдать эссе по ТМО, справка об обучении готова.")
        return text, "fake-model"
