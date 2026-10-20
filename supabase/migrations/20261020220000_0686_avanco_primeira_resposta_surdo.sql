-- manifest: correcao deterministica de estagio primeiro contato lead Surdo (Fluxalvo CRM)

do $$
declare
  v_lead_id uuid := 'a914f0c9-9a8e-428c-bfb2-e3bace9fbda0'::uuid;
  v_lead record;
  v_target_stage_id uuid;
  v_target_stage_name text;
  v_old_stage_name text;
begin
  select l.id, l.organization_id, l.contact_id, l.pipeline_id, l.stage_id
  into v_lead
  from public.crm_leads l
  where l.id = v_lead_id;

  if v_lead.id is not null then
    -- Localiza o estágio de destino correspondente a 'contacted' ("Já respondi") no mesmo funil
    select s.id, s.name
    into v_target_stage_id, v_target_stage_name
    from public.crm_stages s
    where s.pipeline_id = v_lead.pipeline_id
      and (s.agent_stage_hint = 'contacted' or lower(s.name) = 'já respondi' or s.slug = 'contacted')
      and s.is_archived = false
    order by case when s.agent_stage_hint = 'contacted' then 0 else 1 end
    limit 1;

    if v_target_stage_id is not null and v_lead.stage_id <> v_target_stage_id then
      select name into v_old_stage_name from public.crm_stages where id = v_lead.stage_id;

      -- 1. Atualiza crm_leads
      update public.crm_leads
      set stage_id = v_target_stage_id,
          stage_changed_at = now(),
          last_activity_at = now()
      where id = v_lead.id;

      -- 2. Registra a atividade no barramento
      insert into public.crm_lead_activities (
        organization_id,
        lead_id,
        contact_id,
        type,
        actor_kind,
        reason,
        source_module,
        source_id,
        payload
      ) values (
        v_lead.organization_id,
        v_lead.id,
        v_lead.contact_id,
        'stage_changed',
        'system',
        'Movido de ' || coalesce(v_old_stage_name, 'etapa anterior') || ' para ' || v_target_stage_name || ' (primeira resposta humana enviada pelo agente)',
        'crm',
        v_lead.id::text,
        jsonb_build_object(
          'passo_do_agente', 'contacted',
          'de', v_lead.stage_id,
          'para', v_target_stage_id,
          'motivo', 'primeira_resposta_humana_enviada'
        )
      );

      -- 3. Sincroniza lead_state (harness)
      if v_lead.contact_id is not null then
        insert into public.lead_state (
          organization_id,
          contact_id,
          stage,
          updated_at
        ) values (
          v_lead.organization_id,
          v_lead.contact_id,
          'contacted',
          now()
        )
        on conflict (organization_id, contact_id)
        do update set
          stage = 'contacted',
          updated_at = now()
        where lead_state.stage = 'new';
      end if;
    end if;
  end if;
end;
$$;
