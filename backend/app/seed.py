"""Default checklist = the organizers' "Чек-лист качества чатов" (CQA_Chat_Quality_Checklist PDF).

Transcribed from the PDF provided by the organizers; edit through PUT /api/v1/checklist.
"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import ChecklistVersion

S1 = "Начало и понимание запроса"
S2 = "Безопасность и решение"
S3 = "Ведение и завершение диалога"
S4 = "Грубые нарушения"

DEFAULT_CHECKLIST: dict = {
    "name": "Чек-лист качества чатов (организаторы, v1)",
    "comment": "Initial configuration from CQA_Chat_Quality_Checklist.pdf",
    "criteria": [
        {
            "criterion_id": "C01", "name": "Установление контакта", "section": S1, "weight": "10",
            "scoring_type": "binary", "allowed_values": ["Yes", "No"], "na_allowed": False,
            "description": "Да — оператор поздоровался на языке клиента и представился в первом ответе.",
        },
        {
            "criterion_id": "C02", "name": "Выявление потребности", "section": S1, "weight": "15",
            "scoring_type": "binary", "allowed_values": ["Yes", "No"], "na_allowed": True,
            "description": "Да — оператор учёл известные детали и уточнил недостающее до ответа.",
            "na_rule": "Данных для ответа хватало с самого начала.",
        },
        {
            "criterion_id": "C03", "name": "Идентификация", "section": S2, "weight": "20",
            "scoring_type": "binary", "allowed_values": ["Yes", "No"], "na_allowed": True,
            "description": "Да — проверка личности подтверждена до раскрытия данных или защищённого действия. "
            "Если проверка требовалась и не подтверждена в чате — «Нет».",
            "na_rule": "Запрос не требовал идентификации (например, общий вопрос о тарифах).",
        },
        {
            "criterion_id": "C04", "name": "Корректная и полная консультация", "section": S2, "weight": "20",
            "scoring_type": "scaled", "allowed_values": ["0", "5", "10", "15", "20"], "na_allowed": True,
            "description": "Оцените ответ или следующий шаг по шкале.",
            "na_rule": "Чат закончился до того, как клиент сформулировал запрос.",
            "scale_labels": {
                "20": "Все существенные вопросы закрыты или дан корректный следующий шаг.",
                "15": "Основной вопрос решён, пропущена второстепенная деталь.",
                "10": "Часть запроса закрыта, существенный вопрос остался открытым.",
                "5": "Есть общая подсказка, но клиенту всё ещё непонятно, как действовать.",
                "0": "Ответа по существу нет или ключевая рекомендация ошибочна.",
            },
        },
        {
            "criterion_id": "C05", "name": "Эмпатия и клиентоориентированность", "section": S3, "weight": "15",
            "scoring_type": "binary", "allowed_values": ["Yes", "No"], "na_allowed": False,
            "description": "Да — оператор вежлив и, если клиент выразил недовольство или описал неудобство, "
            "отреагировал на конкретную проблему.",
        },
        {
            "criterion_id": "C06", "name": "Управление диалогом, скорость и грамотность", "section": S3,
            "weight": "15", "scoring_type": "scaled", "allowed_values": ["0", "4", "7", "10"], "na_allowed": False,
            "description": "Оцените ясность, порядок ответов и предупреждение об ожидании по шкале.",
            "scale_labels": {
                "10": "Ответы ясные и связные. Если было явное ожидание, оператор предупредил.",
                "7": "Один заметный сбой, но клиент может понять ответ и продолжить.",
                "4": "Клиенту приходится переспрашивать из-за формулировок или порядка ответов.",
                "0": "Из-за бессвязных или противоречивых реплик ход диалога непонятен.",
            },
        },
        {
            "criterion_id": "C07", "name": "Завершение", "section": S3, "weight": "5",
            "scoring_type": "binary", "allowed_values": ["Yes", "No"], "na_allowed": True,
            "description": "Да — оператор подвёл итог или предложил дальнейшую помощь и попрощался.",
            "na_rule": "Чат оборвался до возможности его завершить.",
        },
        {
            "criterion_id": "C08", "name": "Грубые ошибки", "section": S4, "weight": "0",
            "scoring_type": "binary", "allowed_values": ["Yes", "No"], "na_allowed": False,
            "is_gross_error": True,
            "description": "Да — выявлено оскорбление клиента, предложение платной услуги в обход компании "
            "или раскрытие конфиденциальной информации. Нет — ни одно из трёх не выявлено. Без баллов.",
            "gross_error_config": {
                "flag_when": "Yes",
                "categories": ["client_insult", "paid_service_bypassing_company", "confidential_data_disclosure"],
                "affects_score": False,
            },
        },
    ],
}


def seed_default_checklist(db: Session) -> ChecklistVersion | None:
    """Create checklist version 1 if the DB has no checklist yet. Idempotent."""
    if db.scalar(select(ChecklistVersion.id).limit(1)) is not None:
        return None
    from app.schemas.checklist import ChecklistUpdate
    from app.services.checklist_service import create_version

    return create_version(db, ChecklistUpdate.model_validate(DEFAULT_CHECKLIST), created_by="seed")
