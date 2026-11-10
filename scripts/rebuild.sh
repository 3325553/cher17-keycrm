#!/usr/bin/env bash
# Перезбирання шлюзу під новий код + перевірка, що він живий.
#
# Навіщо: на сервері досі стара збірка, яка губить оплачені замовлення
# (падає з «CRM ID не знайдено» ще до створення картки). Код виправлено,
# але без перезбирання правки не діють.
#
# Запуск (на сервері, з теки проєкту):
#   bash scripts/rebuild.sh
#
# Якщо новий код не підніметься — скрипт сам повертає попередній стан,
# щоб шлюз не лишився лежати.

set -euo pipefail

cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"
GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:3000}"
PREV_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo "")"

say() { printf '\n== %s ==\n' "$1"; }

say "1/5 Код з GitHub"
git remote set-url origin https://github.com/3325553/cher17-keycrm.git
git fetch --quiet origin main
git merge --ff-only origin/main
echo "тепер на: $(git log --oneline -1)"

say "2/5 Перебирання контейнера (це займає ~2-3 хвилини)"
docker compose up -d --build

say "3/5 Чекаю, поки шлюз відповість (до 90 с)"
for i in $(seq 1 45); do
  if curl -sf -m 3 "$GATEWAY_URL/health" >/dev/null 2>&1; then
    echo "шлюз відповів на спробі $i"
    break
  fi
  sleep 2
  if [ "$i" -eq 45 ]; then
    echo "❌ шлюз не піднявся — повертаю попередню збірку"
    if [ -n "$PREV_COMMIT" ]; then
      git reset --hard "$PREV_COMMIT"
      docker compose up -d --build
    fi
    exit 1
  fi
done

say "4/5 Перевірка, що працює НОВИЙ код"
HEALTH="$(curl -sf -m 10 "$GATEWAY_URL/health" || echo '{}')"
echo "$HEALTH" | python3 -c "
import sys, json
d = json.load(sys.stdin)
q = d.get('queues', {})
print('  черги: pending=%s delayed=%s deadLetter=%s' % (q.get('pending'), q.get('delayed'), q.get('deadLetter')))
print('  показник витрати CRM (crmRate):', 'є ✓' if 'crmRate' in d else 'НЕМАЄ — код старий ✗')
sys.exit(0 if 'crmRate' in d else 1)
" || {
  echo "❌ Новий код не активний. Найчастіша причина: контейнер зібрався з кешу."
  echo "   Спробуйте: docker compose build --no-cache && docker compose up -d"
  exit 1
}

say "5/5 Останні замовлення в шлюзі"
curl -sf -m 10 -u "${HISTORY_USER:-dev}:${HISTORY_PASS:-dev}" \
  "$GATEWAY_URL/history?status=completed&limit=5" \
  | python3 -c "
import sys, json, datetime
d = json.load(sys.stdin)
for o in (d.get('orders') or [])[:5]:
    ts = o.get('created_at')
    when = datetime.datetime.fromtimestamp(ts / 1000).strftime('%d.%m %H:%M') if ts else '—'
    so = o.get('site_order') or {}
    print('  %s  %s  оплачено=%s  сума=%s' % (o.get('_rowid'), when, so.get('paymentStatus'), so.get('totalCost')))
" 2>/dev/null || echo "  (історія недоступна — не критично)"

say "Готово"
echo "Новий код активний. Далі: стежте, що deadLetter не росте:"
echo "  curl -s $GATEWAY_URL/health | grep deadLetter"
