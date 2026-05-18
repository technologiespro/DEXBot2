#!/usr/bin/env python3
"""
memU Runner - Python subprocess bridge for DEXBot2 claw integration.

This script is called by the Node.js memu_bridge.js module to execute
memU memory operations. It handles argument parsing, service initialization,
and JSON output for the Node.js caller.

Usage:
    python3 memu_runner.py <command> [options]

Commands:
    memorize          Store a resource as memory
    retrieve          Query stored memories
    list-categories   List memory categories
    list-items        List memory items
    create-item       Create a memory item directly
    update-item       Update a memory item
    delete-item       Delete a memory item
    clear             Clear all memory
    status            Get memU service status
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

try:
    from memu import MemoryService
except ImportError:
    print(
        json.dumps({
            "error": "memU package not found. Install with: pip install memu-py",
            "hint": "See https://github.com/NevaMind-AI/memU for installation instructions"
        }),
        file=sys.stderr
    )
    sys.exit(1)


def parse_llm_profiles(raw: str | None) -> dict | None:
    """Parse LLM profiles from JSON string."""
    if not raw:
        return None
    return json.loads(raw)


def parse_db_config(raw: str | None) -> dict | None:
    """Parse database config from JSON string."""
    if not raw:
        return None
    return json.loads(raw)


def parse_user(raw: str | None) -> dict | None:
    """Parse user scope from JSON string."""
    if not raw:
        return None
    return json.loads(raw)


def parse_where(raw: str | None) -> dict | None:
    """Parse generic scope filters from JSON string."""
    if not raw:
        return None
    return json.loads(raw)


async def resolve_category_refs(
    service: MemoryService,
    category_refs: list[str] | None,
    where: dict | None = None,
) -> list[str] | None:
    """Resolve memU category ids or names to the category names expected by CRUD APIs."""
    if category_refs is None:
        return None
    if not category_refs:
        return []

    result = await service.list_memory_categories(where=where)
    categories = result.get("categories", [])
    by_id = {}
    by_name = {}
    for category in categories:
        category_id = category.get("id")
        category_name = category.get("name")
        if isinstance(category_id, str) and category_id:
            by_id[category_id] = category_name
        if isinstance(category_name, str) and category_name:
            by_name[category_name.strip().lower()] = category_name

    resolved: list[str] = []
    seen: set[str] = set()
    unresolved: list[str] = []
    for ref in category_refs:
        if not isinstance(ref, str):
            unresolved.append(str(ref))
            continue
        normalized = ref.strip()
        if not normalized:
            unresolved.append(ref)
            continue
        category_name = by_id.get(normalized) or by_name.get(normalized.lower())
        if not category_name:
            unresolved.append(ref)
            continue
        if category_name not in seen:
            resolved.append(category_name)
            seen.add(category_name)

    if unresolved:
        raise ValueError(f"Unknown memU categories: {', '.join(unresolved)}")
    return resolved


def create_service(args: argparse.Namespace) -> MemoryService:
    """Create a MemoryService instance from CLI arguments."""
    llm_profiles = parse_llm_profiles(getattr(args, 'llm_profile', None))
    db_config = parse_db_config(getattr(args, 'db_config', None))

    service_kwargs: dict = {}

    if llm_profiles:
        service_kwargs["llm_profiles"] = llm_profiles

    if db_config:
        service_kwargs["database_config"] = db_config
    elif hasattr(args, 'memu_dir') and args.memu_dir:
        db_path = Path(args.memu_dir) / "memu.db"
        service_kwargs["database_config"] = {
            "metadata_store": {
                "provider": "sqlite",
                "dsn": f"sqlite:///{db_path}"
            },
        }
    else:
        service_kwargs["database_config"] = {
            "metadata_store": {"provider": "inmemory"},
        }

    if hasattr(args, 'memu_dir') and args.memu_dir:
        blob_dir = Path(args.memu_dir) / "blob"
        blob_dir.mkdir(parents=True, exist_ok=True)
        service_kwargs["blob_config"] = {
            "resources_dir": str(blob_dir)
        }

    return MemoryService(**service_kwargs)


async def cmd_memorize(args: argparse.Namespace) -> dict:
    """Execute memorize command."""
    service = create_service(args)
    user = parse_user(getattr(args, 'user', None))

    result = await service.memorize(
        resource_url=args.resource_url,
        modality=args.modality,
        user=user,
    )
    return result


async def cmd_retrieve(args: argparse.Namespace) -> dict:
    """Execute retrieve command."""
    service = create_service(args)
    queries = json.loads(args.queries)
    where = parse_user(getattr(args, 'where', None))
    method = getattr(args, 'method', 'rag')

    if method == 'llm':
        service.retrieve_config.method = 'llm'

    result = await service.retrieve(
        queries=queries,
        where=where,
    )
    return result


async def cmd_list_categories(args: argparse.Namespace) -> dict:
    """List memory categories."""
    service = create_service(args)
    where = parse_user(getattr(args, 'where', None))

    result = await service.list_memory_categories(where=where)
    return {**result, "count": len(result.get("categories", []))}


async def cmd_list_items(args: argparse.Namespace) -> dict:
    """List memory items."""
    service = create_service(args)
    where = parse_user(getattr(args, 'where', None))

    result = await service.list_memory_items(where=where)
    return {**result, "count": len(result.get("items", []))}


async def cmd_create_item(args: argparse.Namespace) -> dict:
    """Create a memory item directly."""
    service = create_service(args)
    user = parse_user(getattr(args, 'user', None))
    categories = await resolve_category_refs(service, [args.category_ref], where=user)

    return await service.create_memory_item(
        memory_type=args.memory_type,
        memory_content=args.summary,
        memory_categories=categories or [],
        user=user,
    )


async def cmd_update_item(args: argparse.Namespace) -> dict:
    """Update a memory item."""
    service = create_service(args)
    updates = json.loads(args.updates)
    user = updates.get("user")
    memory_categories = updates.get("memory_categories")
    if memory_categories is not None:
        memory_categories = await resolve_category_refs(service, memory_categories, where=user)

    return await service.update_memory_item(
        memory_id=args.item_id,
        memory_type=updates.get("memory_type"),
        memory_content=updates.get("summary") or updates.get("memory_content"),
        memory_categories=memory_categories,
        user=user,
    )


async def cmd_delete_item(args: argparse.Namespace) -> dict:
    """Delete a memory item."""
    service = create_service(args)

    result = await service.delete_memory_item(memory_id=args.item_id)
    return {**result, "item_id": args.item_id}


async def cmd_clear(args: argparse.Namespace) -> dict:
    """Clear all memory."""
    service = create_service(args)
    where = parse_where(getattr(args, 'where', None))

    result = await service.clear_memory(where=where)
    return {**result, "cleared": True}


async def cmd_status(args: argparse.Namespace) -> dict:
    """Get memU service status."""
    service = create_service(args)
    where = parse_where(getattr(args, 'where', None))
    categories_result = await service.list_memory_categories(where=where)
    items_result = await service.list_memory_items(where=where)
    resources = service.database.resource_repo.list_resources(where or {})
    category_count = len(categories_result.get("categories", []))
    item_count = len(items_result.get("items", []))
    resource_count = len(resources)

    return {
        "status": "ready",
        "categories_ready": service._context.categories_ready or category_count > 0,
        "category_count": category_count,
        "item_count": item_count,
        "resource_count": resource_count,
        "llm_profiles": list(service.llm_profiles.profiles.keys()) if service.llm_profiles else [],
        "metadata_store": service.database_config.metadata_store.provider,
    }


COMMANDS = {
    "memorize": cmd_memorize,
    "retrieve": cmd_retrieve,
    "list-categories": cmd_list_categories,
    "list-items": cmd_list_items,
    "create-item": cmd_create_item,
    "update-item": cmd_update_item,
    "delete-item": cmd_delete_item,
    "clear": cmd_clear,
    "status": cmd_status,
}


def build_parser() -> argparse.ArgumentParser:
    """Build argument parser for all commands."""
    parser = argparse.ArgumentParser(description="memU Runner for DEXBot2")
    subparsers = parser.add_subparsers(dest="command", required=True)

    memorize_parser = subparsers.add_parser("memorize", help="Store a resource as memory")
    memorize_parser.add_argument("--resource-url", required=True)
    memorize_parser.add_argument("--modality", required=True)
    memorize_parser.add_argument("--user", default=None)
    memorize_parser.add_argument("--memu-dir", default=None)
    memorize_parser.add_argument("--llm-profile", default=None)
    memorize_parser.add_argument("--db-config", default=None)

    retrieve_parser = subparsers.add_parser("retrieve", help="Query stored memories")
    retrieve_parser.add_argument("--queries", required=True)
    retrieve_parser.add_argument("--where", default=None)
    retrieve_parser.add_argument("--method", default="rag")
    retrieve_parser.add_argument("--memu-dir", default=None)
    retrieve_parser.add_argument("--llm-profile", default=None)
    retrieve_parser.add_argument("--db-config", default=None)

    list_cat_parser = subparsers.add_parser("list-categories", help="List memory categories")
    list_cat_parser.add_argument("--where", default=None)
    list_cat_parser.add_argument("--memu-dir", default=None)
    list_cat_parser.add_argument("--llm-profile", default=None)
    list_cat_parser.add_argument("--db-config", default=None)

    list_items_parser = subparsers.add_parser("list-items", help="List memory items")
    list_items_parser.add_argument("--where", default=None)
    list_items_parser.add_argument("--memu-dir", default=None)
    list_items_parser.add_argument("--llm-profile", default=None)
    list_items_parser.add_argument("--db-config", default=None)

    create_parser = subparsers.add_parser("create-item", help="Create a memory item")
    create_parser.add_argument("--category-id", "--category-name", dest="category_ref", required=True)
    create_parser.add_argument("--summary", required=True)
    create_parser.add_argument("--memory-type", default="knowledge")
    create_parser.add_argument("--user", default=None)
    create_parser.add_argument("--memu-dir", default=None)
    create_parser.add_argument("--llm-profile", default=None)
    create_parser.add_argument("--db-config", default=None)

    update_parser = subparsers.add_parser("update-item", help="Update a memory item")
    update_parser.add_argument("--item-id", required=True)
    update_parser.add_argument("--updates", required=True)
    update_parser.add_argument("--memu-dir", default=None)
    update_parser.add_argument("--llm-profile", default=None)
    update_parser.add_argument("--db-config", default=None)

    delete_parser = subparsers.add_parser("delete-item", help="Delete a memory item")
    delete_parser.add_argument("--item-id", required=True)
    delete_parser.add_argument("--memu-dir", default=None)
    delete_parser.add_argument("--llm-profile", default=None)
    delete_parser.add_argument("--db-config", default=None)

    clear_parser = subparsers.add_parser("clear", help="Clear all memory")
    clear_parser.add_argument("--where", default=None)
    clear_parser.add_argument("--memu-dir", default=None)
    clear_parser.add_argument("--llm-profile", default=None)
    clear_parser.add_argument("--db-config", default=None)

    status_parser = subparsers.add_parser("status", help="Get memU status")
    status_parser.add_argument("--where", default=None)
    status_parser.add_argument("--memu-dir", default=None)
    status_parser.add_argument("--db-config", default=None)

    return parser


def main() -> None:
    """Main entry point."""
    parser = build_parser()
    args = parser.parse_args()

    command_fn = COMMANDS.get(args.command)
    if not command_fn:
        print(
            json.dumps({"error": f"Unknown command: {args.command}"}),
            file=sys.stderr
        )
        sys.exit(1)

    try:
        result = asyncio.run(command_fn(args))
        print(json.dumps(result, default=str))
    except Exception as e:
        print(
            json.dumps({
                "error": str(e),
                "command": args.command,
                "type": type(e).__name__
            }),
            file=sys.stderr
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
