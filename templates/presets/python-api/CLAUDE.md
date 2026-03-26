# Python API Project Guide

## Architecture

This is a Python API project.

```
app/
  main.py             Application entry point
  api/
    routes/           Route handlers organized by domain
    deps.py           Dependency injection (auth, database sessions)
  models/             SQLAlchemy/Prisma models
  schemas/            Pydantic request/response schemas
  services/           Business logic layer
  core/
    config.py         Application settings (pydantic-settings)
    security.py       Authentication and authorization
tests/                Test files mirroring app/ structure
  conftest.py         Shared fixtures
alembic/              Database migrations (if using Alembic)
pyproject.toml        Project configuration and dependencies
```

## FastAPI

### Application Setup

```python
from fastapi import FastAPI

app = FastAPI(title="My API", version="0.1.0")

app.include_router(users_router, prefix="/api/users", tags=["users"])
```

### Route Handlers

```python
from fastapi import APIRouter, Depends, HTTPException, status

router = APIRouter()

@router.get("/", response_model=list[UserResponse])
async def list_users(db: Session = Depends(get_db)):
    return await user_service.list_all(db)

@router.post("/", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(data: CreateUserRequest, db: Session = Depends(get_db)):
    return await user_service.create(db, data)
```

### Dependency Injection

Use `Depends()` for shared logic (auth, database sessions, pagination):

```python
async def get_current_user(token: str = Depends(oauth2_scheme)) -> User:
    payload = verify_token(token)
    user = await get_user_by_id(payload.sub)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid token")
    return user
```

## Django

### URL Configuration

```python
urlpatterns = [
    path("api/users/", UserListView.as_view()),
    path("api/users/<int:pk>/", UserDetailView.as_view()),
]
```

### Views (DRF)

```python
from rest_framework import viewsets
from .models import User
from .serializers import UserSerializer

class UserViewSet(viewsets.ModelViewSet):
    queryset = User.objects.all()
    serializer_class = UserSerializer
    permission_classes = [IsAuthenticated]
```

## Pydantic Models

Define request and response schemas with Pydantic:

```python
from pydantic import BaseModel, EmailStr

class CreateUserRequest(BaseModel):
    email: EmailStr
    name: str
    role: str = "user"

class UserResponse(BaseModel):
    id: int
    email: str
    name: str
    role: str

    model_config = ConfigDict(from_attributes=True)
```

## Database (SQLAlchemy)

```python
from sqlalchemy import Column, Integer, String
from app.core.database import Base

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True, nullable=False)
    name = Column(String, nullable=False)
    hashed_password = Column(String, nullable=False)
```

Use Alembic for migrations:

```bash
alembic revision --autogenerate -m "add users table"
alembic upgrade head
```

## Testing

```bash
pytest                        # run all tests
pytest -v                     # verbose output
pytest -x                     # stop on first failure
pytest --cov=app              # run with coverage
pytest tests/test_users.py    # run specific test file
```

### Test Structure

```python
import pytest
from httpx import AsyncClient
from app.main import app

@pytest.fixture
async def client():
    async with AsyncClient(app=app, base_url="http://test") as ac:
        yield ac

@pytest.mark.anyio
async def test_create_user(client: AsyncClient):
    response = await client.post("/api/users/", json={
        "email": "test@example.com",
        "name": "Test User",
    })
    assert response.status_code == 201
    data = response.json()
    assert data["email"] == "test@example.com"
```

### Fixtures

Use `conftest.py` for shared fixtures (database sessions, test clients, factory functions).

## Type Checking

```bash
mypy .                        # type check entire project
mypy app/services/            # type check specific directory
```

Configure in `pyproject.toml`:

```toml
[tool.mypy]
strict = true
plugins = ["pydantic.mypy"]
```

## Linting

```bash
ruff check .                  # lint all files
ruff check --fix .            # auto-fix issues
ruff format .                 # format code
```

## Coding Conventions

- **Type hints** on all function signatures. Use `strict` mode in mypy.
- **Async/await** for all I/O operations (database, HTTP, file system).
- **Pydantic** for all request/response validation. Never trust raw input.
- **Dependency injection** for database sessions, auth, and shared services.
- **Environment variables**: Use `pydantic-settings` for configuration. Validate at startup.
- **File naming**: `snake_case.py` for all source files.
- **Error handling**: Raise `HTTPException` with appropriate status codes. Use custom exception handlers for domain errors.
- **No business logic in route handlers**. Route handlers parse input, call services, and return responses.
