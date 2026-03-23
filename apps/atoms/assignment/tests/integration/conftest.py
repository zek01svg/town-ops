import os

os.environ.setdefault("DATABASE_URL", "postgresql://dummy:dummy@localhost/dummy")
os.environ.setdefault("RABBITMQ_URL", "amqp://guest:guest@localhost:5672")
