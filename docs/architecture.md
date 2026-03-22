# System Architecture

## Core Philosophy: Atomic & Composite

TownOps is built around the **Atomic/Composite** microservices pattern, designed to achieve clean separation of concerns and maintainable data ownership.

### 1. Atomic Services (Atoms)

- **Role**: Domain Data Owners.
- **Tech**: Bun + Hono
- **Rules**:
  - Each atom owns exactly one database table (or a set of related tables).
  - Atoms **never** call other atoms via HTTP.
  - Atoms are agnostic of the business processes they belong to.

### 2. Composite Services (Composites)

- **Role**: Business Logic Orchestrators.
- **Tech**: Python + FastAPI
- **Rules**:
  - Composites do not have their own persistent storage.
  - They coordinate multiple atoms using HTTP REST calls.
  - They are responsible for workflow execution and state coordination.
  - They emit process-driven events (e.g., `Case_Opened`) to coordinate downstream workflows asynchronously.

### 3. Messaging Layer (AMQP)

- **Broker**: RabbitMQ.
- **Patterns**:
  - **Process Choreography**: Composites publish process states (e.g., `Case_Opened`, `Job_Assigned`).
  - **SLA Monitors (DLX)**: Delayed queues with TTL that route to a Dead Letter Exchange on expiration (e.g., triggers `SLA_Breached`).
  - **Audit & Analytics**: Consumer queues for `Metrics` and `Alert` tracking.

## Data Flow Illustration (Ideal Case Creation)

```mermaid
flowchart TD
    %% Define Nodes
    UI["Officer / Contractor UI"]

    subgraph Composites ["Composite Layer (Processes)"]
        OpenCase["Open Case"]
        AssignJob["Assign Job"]
        AcceptJob["Accept Job"]
        CloseCase["Close Case"]
    end

    subgraph Atoms ["Atomic Layer (Data)"]
        Resident["Resident"]
        Case["Case"]
        Assignment["Assignment"]
        Appointment["Appointment"]
        Proof["Proof"]
        Metrics["Metrics"]
        Alert["Alert"]
    end

    Contractor["Contractor (OutSystems)"]

    %% Flow 1: Opening
    UI -- "1. HTTP POST" --> OpenCase
    OpenCase -- "2. HTTP GET" --> Resident
    OpenCase -- "3. HTTP POST" --> Case
    OpenCase -.->|AMQP: Case_Opened| AssignJob

    %% Flow 2: Assigning
    AssignJob -- "4. HTTP GET" --> Contractor
    AssignJob -- "5. HTTP POST" --> Assignment
    AssignJob -.->|AMQP: Job_Assigned| Alert

    %% Flow 3: Accepting
    UI -- "6. HTTP PUT" --> AcceptJob
    AcceptJob -- "7. HTTP PUT" --> Assignment
    AcceptJob -- "8. HTTP PUT" --> Case
    AcceptJob -- "9. HTTP POST" --> Appointment

    %% Flow 4: Closing
    UI -- "10. HTTP POST" --> CloseCase
    CloseCase -- "11. HTTP POST" --> Proof
    CloseCase -- "12. HTTP PUT" --> Case
    CloseCase -.->|AMQP: Job_Done| Metrics
    CloseCase -.->|AMQP: Job_Done| Alert

    %% Styling
    style OpenCase fill:#f9f,stroke:#333,stroke-width:2px
    style AssignJob fill:#f9f,stroke:#333,stroke-width:2px
    style AcceptJob fill:#f9f,stroke:#333,stroke-width:2px
    style CloseCase fill:#f9f,stroke:#333,stroke-width:2px

    style Case fill:#ffff00,stroke:#333,stroke-width:1px
    style Resident fill:#ffff00,stroke:#333,stroke-width:1px
    style Assignment fill:#ffff00,stroke:#333,stroke-width:1px
    style Appointment fill:#ffff00,stroke:#333,stroke-width:1px
    style Proof fill:#ffff00,stroke:#333,stroke-width:1px
    style Metrics fill:#ffff00,stroke:#333,stroke-width:1px
    style Alert fill:#dae8fc,stroke:#6c8ebf,stroke-width:1px
    style Contractor fill:#dae8fc,stroke:#6c8ebf,stroke-width:1px
    style UI fill:#fff,stroke:#333,stroke-width:1px
```

## Scaling Strategy

- **Horizontal Scaling**: Each service is containerized (Docker) and can be scaled independently based on workload.
- **Scale-to-Zero**: Infrastructure supports scale-to-zero configurations (e.g., Azure Container Apps) for cost-efficient operations.
