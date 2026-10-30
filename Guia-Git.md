# Guía de trabajo con Git y GitHub

Esta guía describe el flujo de trabajo que utilizaremos para colaborar en los repositorios de **frontend** y **backend**. Está pensada para personas que están comenzando a utilizar Git y establece el uso de **Git CLI** como procedimiento estándar.

## 1. Stack tecnológico

- **Frontend:** React + Vite.
- **Backend:** Node.js + Express.
- **Base de datos:** PostgreSQL.
- **Acceso a datos:** Prisma.
- **Servicio de base de datos:** Supabase.
- **Control de versiones y Pull Requests:** Git y GitHub.
 
## 2. Objetivo del flujo de trabajo

Las ramas `main` y `dev` son ramas compartidas y protegidas. **No se debe trabajar directamente sobre ellas ni intentar subir cambios directamente.**

- `main`: contiene la versión aprobada para producción.
- `dev`: integra los cambios aprobados y sirve como base de trabajo para nuevas tareas.
- `feature/*`, `fix/*`, `test/*`, etc.: ramas temporales o de trabajo individuales.

Flujo habitual:

```text
main
  ↑ Pull Request de dev a main (2 aprobaciones)
dev
  ↑ Pull Request de rama de trabajo a dev (1 aprobación)
feature/*, fix/*, test/*, docs/*, refactor/*
```

Los cambios se integran primero en `dev`. Solo cuando el equipo considera que existe un avance listo para producción se abre un Pull Request de `dev` hacia `main`.

## 3. Requisitos previos

Antes de comenzar, asegúrese de tener:

1. **Git** instalado.
2. Una cuenta de GitHub con acceso al repositorio.
3. Git CLI disponible en la terminal.
4. El entorno requerido por el repositorio (por ejemplo, Node.js y npm cuando corresponda). Consulte el README específico del repositorio.

Compruebe que Git está instalado:

```bash
git --version
```

## 4. Clonar el repositorio

Copie la URL del repositorio desde GitHub. Use la URL real del repositorio de frontend o backend al que tenga acceso:

```bash
git clone <URL_DEL_REPOSITORIO>
cd <CARPETA_DEL_REPOSITORIO>
```

Compruebe el estado y las ramas disponibles:

```bash
git status
git branch
git branch -a
```
- `git status`muestra la rama actual y si hay cambios pendientes.
- `git branch` muestra las ramas locales.
- `git branch -a` muestra las ramas locales y las referencias remotas conocidas.

Si acaba de clonar el repositorio, actualice la información remota:

```bash
git fetch origin
```

## 5. Crear una rama de trabajo desde `dev`

**Toda nueva tarea debe comenzar desde la versión más reciente de `dev`.** No cree una rama nueva desde `main`, otra rama de trabajo ni una versión antigua de su rama local.

Primero, asegúrese de no tener cambios sin guardar. Si tiene trabajo pendiente, haga commit o guárdelo de forma segura antes de cambiar de rama.

```bash
git switch dev
git pull --ff-only origin dev
git switch -c feature/nombre-descriptivo
```

Ejemplo:

```bash
git switch dev
git pull --ff-only origin dev
git switch -c feature/login-usuario
```

`git switch -c` crea la rama y cambia a ella. El nombre es solo un ejemplo: utilice uno que describa su tarea.

Si su copia local no tiene todavía la rama `dev`, ejecute:

```bash
git fetch origin
git switch --track origin/dev
git pull --ff-only
```

Si Git indica que `dev` ya existe, no vuelva a crearla; cambie a ella y actualícela.

## 6. Nomenclatura de ramas

Use nombres cortos, descriptivos, en minúsculas y separados por guiones. El prefijo identifica el propósito de la rama.

| Prefijo | Uso | Ejemplo |
|---|---|---|
| `feature/` | Nueva funcionalidad | `feature/registro-usuario` |
| `fix/` | Corrección de un error | `fix/error-validacion` |
| `test/` | Pruebas nuevas o ajustes de pruebas | `test/pruebas-login` |
| `docs/` | Documentación | `docs/guia-instalacion` |
| `refactor/` | Reorganización interna sin cambiar el comportamiento esperado | `refactor/servicio-usuarios` |
| `chore/` | Mantenimiento, herramientas o tareas auxiliares | `chore/actualizar-dependencias` |
| `hotfix/` | Corrección urgente de producción; coordinar con el responsable antes de crearla | `hotfix/error-autenticacion` |

No use espacios, tildes ni nombres genéricos como `cambios`, `prueba` o `rama1`. Evite reutilizar una rama para tareas distintas.

## 7. Trabajar y revisar los cambios

Realice los cambios únicamente en su rama de trabajo. Antes de preparar un commit, revise el estado:

```bash
git status
git diff
```

`git diff` muestra cambios no preparados. Para revisar también los cambios que ya se prepararon para el commit:

```bash
git diff --staged
```

Prepare los archivos que desea incluir. Es preferible agregar archivos concretos en lugar de agregar todo sin revisarlo:

```bash
git add ruta/al/archivo
```

Si ya revisó todos los cambios y está seguro de que no se incluirán archivos no deseados, también puede usar:

```bash
git add .
```

Antes de confirmar, revise nuevamente:

```bash
git status
git diff --staged
```

No incluya contraseñas, tokens, claves privadas, archivos `.env` con credenciales, dependencias descargadas ni artefactos generados. El `.gitignore` ayuda a excluir ciertos archivos, pero siempre debe revisar lo que está preparando.

## 8. Mensajes de commit: Conventional Commits

Los commits deben seguir el formato:

```text
tipo: descripción breve en imperativo
```

Tipos recomendados:

| Tipo | Cuándo utilizarlo | Ejemplo |
|---|---|---|
| `feat` | Nueva funcionalidad | `feat: agregar formulario de registro` |
| `fix` | Corrección de un error | `fix: validar correo vacío` |
| `docs` | Documentación | `docs: explicar flujo de ramas` |
| `test` | Pruebas | `test: cubrir validación de usuario` |
| `refactor` | Reestructuración sin cambio funcional previsto | `refactor: separar lógica de autenticación` |
| `chore` | Mantenimiento o configuración | `chore: actualizar configuración de lint` |
| `build` | Dependencias o sistema de construcción | `build: configurar scripts de Vite` |
| `ci` | Integración continua | `ci: validar pull requests` |
| `style` | Formato sin cambiar la lógica | `style: ordenar imports` |

Ejemplo de commit:

```bash
git commit -m "feat: agregar validación del formulario"
```

El mensaje debe describir el cambio principal, no la actividad de Git. Evite mensajes como `cambios`, `arreglos`, `update` o `final`.

Para un cambio que necesita más contexto, puede usar un asunto breve y un cuerpo explicativo:

```bash
git commit
```

Se abrirá el editor configurado para Git. Escriba el asunto en la primera línea, deje una línea en blanco y agregue la explicación si hace falta.

## 9. Subir la rama al repositorio remoto

Cuando tenga un conjunto coherente de cambios, haga commit y suba su rama:

```bash
git push -u origin feature/nombre-descriptivo
```

Reemplace el nombre de ejemplo por el nombre de su rama. La opción `-u` establece la rama remota como referencia de seguimiento; en los siguientes envíos normalmente bastará con:

```bash
git push
```

(Esto solo aplica para la rama en la que esta trabajando actualmente, sobre la que ejecuto el comando git push -u origin <Nombre-de-la-rama>

**Subir una rama no integra sus cambios en `dev` ni en `main`.** Para integrar cambios, debe abrir un Pull Request en GitHub.

## 10. Abrir un Pull Request hacia `dev`

En GitHub:

1. Abra el repositorio correcto.
2. Cree un Pull Request desde su rama de trabajo hacia `dev`.
3. Verifique que la rama de origen sea su rama (`feature/...`, `fix/...`, etc.) y que la rama de destino sea `dev`.
4. Escriba un título claro y describa qué cambió, por qué y cómo lo probó.
5. Relacione la tarea o incidencia, si existe.
6. Solicite revisión a la persona responsable o al equipo correspondiente.
7. Espere la aprobación requerida y atienda los comentarios.

**No cambie el destino a `main` para saltarse `dev`.** Los cambios de trabajo deben integrarse primero en `dev`.

Antes de solicitar revisión, compruebe que:

- El cambio cumple el objetivo de la tarea.
- La aplicación compila o ejecuta según las instrucciones del repositorio.
- Las pruebas disponibles pasan.
- No hay secretos ni archivos locales incluidos.
- La documentación se actualizó cuando fue necesario.
- El Pull Request explica los cambios y sus posibles efectos.

La política del repositorio exige al menos **1 aprobación de una persona distinta del autor** para integrar en `dev`. Si la aprobación no está disponible o se solicitan cambios, no intente eludir la regla.

## 11. Qué hacer después de integrar un Pull Request

Una vez que el Pull Request se haya integrado en `dev`:

1. Compruebe en GitHub que el Pull Request aparece como integrado (*merged*).
2. Actualice su información remota:

```bash
git fetch origin
```

3. Puede conservar su rama local para consultar el trabajo o eliminarla cuando ya no la necesite:

```bash
git switch dev
git branch -d feature/nombre-descriptivo
```

El comando `git branch -d` elimina únicamente la rama local y normalmente requiere que sus cambios estén integrados. **La política del equipo es eliminar las ramas remotas después del merge**, no obligar a eliminar inmediatamente las ramas locales. La eliminación remota puede realizarse mediante la opción de GitHub o, si fuera necesario:

```bash
git push origin --delete feature/nombre-descriptivo
```

No elimine una rama remota mientras su Pull Request siga abierto o si otros desarrolladores todavía dependen de ella.

## 12. Reglas de colaboración y seguridad

- No haga commits directamente en `dev` o `main`.
- No abra Pull Requests de ramas de trabajo directamente hacia `main`.
- No use `--force` para sobrescribir el historial.
- No comparta credenciales, tokens ni archivos `.env` reales.
- No incluya dependencias instaladas o archivos generados salvo que el proyecto indique expresamente lo contrario.
- Mantenga los cambios de cada rama enfocados en una tarea.
- Antes de solicitar revisión, pruebe sus cambios y describa qué verificó.
- No apruebe su propio Pull Request ni solicite a una misma persona que represente varias aprobaciones.
- Si una regla de GitHub bloquea una operación, no intente evitarla: revise el mensaje y solicite ayuda al responsable.
- Los cambios de esquema o migraciones de Prisma y PostgreSQL deben revisarse con especial cuidado. No ejecute migraciones sobre entornos compartidos o de producción sin seguir el procedimiento definido para el proyecto.

## 13. Flujo de trabajo resumido

Para una nueva funcionalidad el proceso sera:

```bash
# 1. Actualizar la información remota
git fetch origin

# 2. Crear la rama desde dev actualizado
git switch dev
git pull --ff-only origin dev
git switch -c feature/nombre-descriptivo

# 3. Trabajar y revisar
git status
git diff

# 4. Preparar y confirmar los cambios
git add ruta/al/archivo
git diff --staged
git commit -m "feat: describir la funcionalidad"

# 5. Subir la rama
git push -u origin feature/nombre-descriptivo
```

Despues, abra en Github un Pull Request de: **feat/nombre-descriptivo** hacia **dev**. Tras su aprobación e integración, los cambios podrán formar parte de un Pull Request de **dev** hacia **main** cuando el equipo los considere listos para produccion.
